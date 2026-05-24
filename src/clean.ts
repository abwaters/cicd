import { ExportConfig, FunctionConfig, WorkerFunctionConfig, StageConfig, CleanApiResult, CleanTopicResult, CleanQueueResult, CleanFunctionResult, CleanWorkerResult, CleanEcrResult } from './types';

import * as sns from './shared/sns';
import * as lambda from './shared/lambda';
import * as apigw from './shared/apigw';
import * as ecs from './shared/ecs';
import * as ecr from './shared/ecr';
import * as s3 from './shared/s3';
import * as cloudfront from './shared/cloudfront';
import * as cicd from './shared/cicd';
import * as awsContext from './shared/aws-context';
import * as credentials from './shared/credentials';
import * as options from './shared/options';
import * as logger from './shared/logger';
import { printHeader } from './shared/header';

async function main(): Promise<void> {
    // Validate AWS credentials before proceeding
    await credentials.validateCredentials();

    // Parse options
    const args = process.argv.slice(2);
    const o = options.getOptions(args);

    // Set verbose mode if requested
    if (o.verbose) {
        logger.setVerbose(true);
        logger.log('Verbose mode enabled');
    }

    const account = await awsContext.getAccount();
    const region = await awsContext.getRegion();
    const app: string = await cicd.getConfig("app");
    const dryRun = !!o.dryRun;

    // Keep window — last N successful deployments per stage. Drives both web
    // S3 prefix retention and the Lambda/Fargate keep-set unions.
    const keepN = o.keep ? Number(o.keep) : 5;
    if (!Number.isFinite(keepN) || keepN < 1) {
        console.error(`Error: --keep must be a positive integer (got '${o.keep}')`);
        process.exit(1);
    }
    const keep = await cicd.buildKeepSet(keepN);

    console.time("api cicd");
    if (!o.noHeader) printHeader();

    const dryRunLabel = dryRun ? ' [DRY RUN]' : '';
    console.log(`Cleaning with keep window N=${keepN}${dryRunLabel}`);

    // Print keep set per stage
    if (keep.size > 0) {
        console.log(`\nKeep set (recoverable commits per stage):`);
        for (const [stageName, commits] of keep) {
            const list = [...commits];
            console.log(`  ${stageName.padEnd(15)} ${list.length === 0 ? 'none' : list.join(', ')}`);
        }
    }

    const computeMode = (await cicd.getConfig("computeMode")) || 'lambda';

    // ── Web phase (runs in any compute mode) ─────────────────────────
    const webExports: ExportConfig[] = await cicd.getExportsByType('web');
    if (webExports.length > 0) {
        console.log(`\nWeb cleanup:`);
        const allStages: StageConfig[] = await cicd.getConfig("stages");
        for (const w of webExports) {
            const bucket = w.value!;
            const distribution = w.distributionValue!;
            const applicableStages = allStages.filter(s => !w.stages || w.stages.includes(s.stage));

            // Drift check: CF OriginPath should equal /{stage}/{recent[0]}
            for (const s of applicableStages) {
                try {
                    const originPath = await cloudfront.getOriginPath(distribution, s.stage);
                    const recent = [...(keep.get(s.stage) ?? new Set<string>())][0];
                    if (originPath && recent) {
                        const expected = `/${s.stage}/${recent}`;
                        if (originPath !== expected) {
                            console.log(`  WARN: ${w.name} stage '${s.stage}' OriginPath '${originPath}' != most-recent kept '${expected}' (drift)`);
                        }
                    }
                } catch (e: any) {
                    logger.verbose(`   - drift check failed for ${w.name}/${s.stage}: ${e.message}`);
                }
            }

            // Per-stage prefix cleanup
            for (const s of applicableStages) {
                const stagePrefix = `${s.stage}/`;
                const commitPrefixes = await s3.listCommonPrefixes(bucket, stagePrefix);
                const keepStage = keep.get(s.stage) ?? new Set<string>();
                let removed = 0, kept = 0, removedBytes = 0;
                for (const cp of commitPrefixes) {
                    // cp shape: '{stage}/{commit}/' — extract commit
                    const trimmed = cp.replace(/\/$/, '');
                    const segments = trimmed.split('/');
                    const commit = segments[segments.length - 1];
                    if (keepStage.has(commit)) {
                        kept++;
                        logger.verbose(`   - keep s3://${bucket}/${cp}`);
                    } else {
                        const keys = await s3.listObjectsByPrefix(bucket, cp);
                        if (dryRun) {
                            logger.verbose(`   - WOULD delete s3://${bucket}/${cp} (${keys.length} objects)`);
                        } else {
                            const deleted = await s3.deleteObjects(bucket, keys);
                            logger.verbose(`   - deleted s3://${bucket}/${cp} (${deleted}/${keys.length} objects)`);
                        }
                        removed++;
                        removedBytes += keys.length;
                    }
                }
                console.log(`  ${w.name.padEnd(30)} stage ${s.stage.padEnd(10)} kept ${kept}, ${dryRun ? 'would remove' : 'removed'} ${removed} commit folder(s) (${removedBytes} object(s))`);
            }
        }
    }

    if (computeMode === 'fargate') {
        // ── Fargate clean flow ───────────────────────────────────────
        console.log(`Cleaning old Fargate task definition revisions and ECR images...`);
        const fargateConfig = await cicd.resolveFargateConfig();
        const stages: StageConfig[] = await cicd.getConfig("stages");
        let totalDeregistered = 0;
        const activeTags = new Set<string>();

        // Deduplicate task families — multiple stages may share one
        const familyMap = new Map<string, { stages: string[]; service: string }>();
        for (const stage of stages) {
            if (!stage.service || !stage.taskFamily) continue;
            if (!familyMap.has(stage.taskFamily)) {
                familyMap.set(stage.taskFamily, { stages: [stage.stage], service: stage.service });
            } else {
                familyMap.get(stage.taskFamily)!.stages.push(stage.stage);
            }
        }

        // ── Phase 1: Task definition cleanup ─────────────────────────
        console.log(`\nTask Definition Cleanup:`);
        for (const [taskFamily, info] of familyMap) {
            try {
                const serviceInfo = await ecs.describeService(fargateConfig.cluster, info.service);
                const activeTaskDefArn = serviceInfo.taskDefinitionArn;

                // Extract active image tag from the task definition
                const taskDef = await ecs.describeTaskDefinition(activeTaskDefArn);
                const container = (taskDef.containerDefinitions || [])
                    .find((c: any) => c.name === fargateConfig.containerName);
                const imageTag = container?.image?.split(':')[1];
                if (imageTag) activeTags.add(imageTag);

                // Per-family keep tag set: union of keep across stages on this family.
                const familyKeepTags = new Set<string>();
                for (const sName of info.stages) {
                    const kt = keep.get(sName);
                    if (kt) for (const c of kt) familyKeepTags.add(c);
                }
                // Drift check: live tag should match recent[0] for any of this family's stages.
                if (imageTag) {
                    const recents = info.stages
                        .map(s => [...(keep.get(s) ?? new Set<string>())][0])
                        .filter(Boolean);
                    if (recents.length > 0 && !recents.includes(imageTag)) {
                        console.log(`  WARN: ${taskFamily} live image tag '${imageTag}' != most-recent kept (${recents.join(', ')}) (drift)`);
                    }
                }

                const revisions: string[] = await ecs.listTaskDefinitionRevisions(taskFamily);
                let deregistered = 0;
                for (const rev of revisions) {
                    if (rev === activeTaskDefArn) {
                        logger.verbose(`   - Active: ${rev}`);
                        continue;
                    }
                    // Inspect this revision's image tag; keep if in window.
                    let revTag: string | undefined;
                    try {
                        const revTaskDef = await ecs.describeTaskDefinition(rev);
                        const revContainer = (revTaskDef.containerDefinitions || [])
                            .find((c: any) => c.name === fargateConfig.containerName);
                        revTag = revContainer?.image?.split(':')[1];
                    } catch (e: any) {
                        logger.verbose(`   - failed to describe ${rev}: ${e.message}`);
                    }
                    if (revTag && familyKeepTags.has(revTag)) {
                        logger.verbose(`   - Keep ${rev} (image tag '${revTag}' in window)`);
                        activeTags.add(revTag);
                        continue;
                    }
                    logger.verbose(`   - ${dryRun ? 'WOULD deregister' : 'Deregistering'} ${rev}`);
                    if (!dryRun) await ecs.deregisterTaskDefinition(rev);
                    deregistered++;
                }
                totalDeregistered += deregistered;
                const activeRevision = activeTaskDefArn.split(':').pop() || '?';
                const stageLabel = info.stages.join(', ');
                console.log(`  ${taskFamily.padEnd(30)} active rev ${activeRevision}, ${dryRun ? 'would deregister' : 'deregistered'} ${deregistered} (${stageLabel})`);
            } catch (e: any) {
                const stageLabel = info.stages.join(', ');
                console.log(`  ${taskFamily.padEnd(30)} error: ${e.message} (${stageLabel})`);
            }
        }

        // Union all keep tags across all stages — ECR is shared across stages.
        for (const set of keep.values()) {
            for (const c of set) activeTags.add(c);
        }

        // ── Phase 2: ECR image cleanup ───────────────────────────────
        let totalEcrDeleted = 0;
        let totalEcrFailures = 0;
        console.log(`\nECR Image Cleanup:`);

        if (activeTags.size === 0) {
            console.log(`  Skipping: no active stages found`);
        } else {
            try {
                const repositoryName = ecr.parseRepositoryName(fargateConfig.ecrRepository);
                const allImages = await ecr.listImages(repositoryName);

                const toDelete = allImages.filter((img: any) => {
                    if (!img.imageTag) return true; // untagged — always clean up
                    return !activeTags.has(img.imageTag);
                });

                const activeCount = allImages.length - toDelete.length;
                const activeTagList = [...activeTags].map(t => t.substring(0, 7)).join(', ');

                if (toDelete.length > 0) {
                    if (dryRun) {
                        totalEcrDeleted = toDelete.length;
                        for (const img of toDelete) {
                            logger.verbose(`   - WOULD delete ${img.imageTag ?? '(untagged)'}@${img.imageDigest}`);
                        }
                        console.log(`  ${repositoryName.padEnd(30)} ${totalEcrDeleted} would be deleted, ${activeCount} active (${activeTagList})`);
                    } else {
                        const result = await ecr.batchDeleteImages(repositoryName, toDelete);
                        totalEcrDeleted = result.deleted;
                        totalEcrFailures = result.failures;
                        console.log(`  ${repositoryName.padEnd(30)} ${totalEcrDeleted} deleted, ${activeCount} active (${activeTagList})`);
                        if (totalEcrFailures > 0) {
                            console.log(`  ${' '.padEnd(30)} ${totalEcrFailures} failures`);
                        }
                    }
                } else {
                    console.log(`  ${repositoryName.padEnd(30)} no unused images, ${activeCount} active (${activeTagList})`);
                }
            } catch (e: any) {
                console.log(`  error: ${e.message}`);
            }
        }

        const verb = dryRun ? 'would' : '';
        console.log(`\nSummary${dryRunLabel}: ${verb ? verb + ' deregister' : 'Deregistered'} ${totalDeregistered} task definition revisions, ${verb ? verb + ' delete' : 'deleted'} ${totalEcrDeleted} ECR images`);
        console.log();
        console.timeEnd("api cicd");
        return;
    }

    // ── Lambda clean flow (existing behavior) ───────────────────────
    console.log(`Preparing clean api gateway deployments and lambda aliases/versions...`);

    // get list of exports from cloudformation
    const apis: ExportConfig[] = await cicd.getExportsByType('api');
    const topics: ExportConfig[] = await cicd.getExportsByType('sns');
    const queues: ExportConfig[] = await cicd.getExportsByType('sqs');
    const apiFunctions: FunctionConfig[] = await cicd.getLambdaExports('api');
    const snsFunctions: FunctionConfig[] = await cicd.getLambdaExports('sns');
    const sqsFunctions: FunctionConfig[] = await cicd.getLambdaExports('sqs');
    const workers: WorkerFunctionConfig[] = await cicd.getWorkers();
    const functions = [...apiFunctions,...snsFunctions,...sqsFunctions];
    const stageList: StageConfig[] = await cicd.getConfig('stages');
    const stageNames = new Set(stageList.map(s => s.stage));
    const WORKER_VERSION_RETENTION = 5;
    let activeCommits = new Map<string, boolean>();
    let deletedDeployments=0,
        deletedAliases=0,
        deletedVersions=0;

    // Map commit -> array of stage names (for the summary)
    const commitStages = new Map<string, string[]>();

    // Per-API results for summary
    const apiResults: CleanApiResult[] = [];

    // Pre-compute alias keep set for every stage: {app}-{commit} for each commit in the
    // window. Lambda artifacts are alias-named, so we work in alias space here.
    const aliasKeepByStage = new Map<string, Set<string>>();
    for (const [stageName, commits] of keep) {
        const aliases = new Set<string>();
        for (const c of commits) aliases.add(`${app}-${c}`);
        aliasKeepByStage.set(stageName, aliases);
    }

    // Seed activeCommits with the keep-window alias union across all stages, so Lambda
    // function aliases and worker versions tied to recoverable commits aren't pruned.
    for (const aliases of aliasKeepByStage.values()) {
        for (const a of aliases) activeCommits.set(a, true);
    }

    // ── Phase 1: Scan API stages & clean deployments ──────────────────
    for(const api of apis) {
        const apiId = api.value!;
        const stages = await apigw.listStages(apiId);
        const activeDeployments = new Map<string, string[]>();
        // Per-API keep alias set: union of aliasKeep over the stages this API serves.
        const apiAliasKeep = new Set<string>();
        for(const s of stages) {
            const commit = s.variables!.Commit;
            activeCommits.set(commit, true);

            // Track commit -> stages mapping
            if (!commitStages.has(commit)) {
                commitStages.set(commit, []);
            }
            if (!commitStages.get(commit)!.includes(s.stageName!)) {
                commitStages.get(commit)!.push(s.stageName!);
            }

            // Accumulate stage names per deployment (fixes bug where second stage replaced first)
            if (!activeDeployments.has(s.deploymentId!)) {
                activeDeployments.set(s.deploymentId!, [s.stageName!]);
            } else {
                activeDeployments.get(s.deploymentId!)!.push(s.stageName!);
            }

            // Add this stage's keep aliases to the per-API union
            const sw = aliasKeepByStage.get(s.stageName!);
            if (sw) for (const a of sw) apiAliasKeep.add(a);
        }
        // Add union into activeCommits so downstream Lambda alias checks honor the window.
        for (const a of apiAliasKeep) activeCommits.set(a, true);

        const deployments = await apigw.listDeployments(apiId);
        let removed = 0;
        let activeCount = 0;
        const activeStageLabels: string[] = [];
        for(const d of deployments) {
            const isLive = activeDeployments.has(d.id!);
            const isInKeep = !!d.description && apiAliasKeep.has(d.description);
            if (!isLive && !isInKeep) {
                logger.verbose(`   - Deployment '${d.id}' deleted from ${api.name}`);
                if (!dryRun) await apigw.deleteDeployment(apiId, d.id!);
                deletedDeployments++;
                removed++;
            } else if (isLive) {
                const stageNames = activeDeployments.get(d.id!)!;
                logger.verbose(`   - Deployment '${d.id}' active (${stageNames.join(', ')})`);
                activeCount++;
                activeStageLabels.push(stageNames.sort().join('/'));
            } else {
                // In keep window but not currently bound to a live stage — kept for rollback.
                logger.verbose(`   - Deployment '${d.id}' kept for rollback (${d.description})`);
                activeCount++;
                activeStageLabels.push('keep');
            }
        }
        apiResults.push({ name: api.name, removed, activeCount, activeStageLabels });
    }

    // ── Phase 2: Scan SNS topics ──────────────────────────────────────
    const topicResults: CleanTopicResult[] = [];
    for(const topic of topics) {
        const subscriptions = await sns.listSubscriptionsByTopic(topic.value!);
        let topicCommit: string | null = null;
        for(const subscription of subscriptions) {
            const f = await lambda.describeFunction(subscription.endpoint);
            const parts = subscription.endpoint.split(':');
            if (parts.length === 8) {
                logger.verbose(`   - Lambda alias '${parts[7]}' active on ${topic.name}`);
                activeCommits.set(parts[7], true);
                topicCommit = parts[7];

                // Track commit -> stages mapping for SNS
                if (!commitStages.has(parts[7])) {
                    commitStages.set(parts[7], []);
                }
            }
        }
        topicResults.push({ name: topic.name, commit: topicCommit });
    }

    // ── Phase 2b: Scan SQS queue event source mappings ────────────────
    const queueResults: CleanQueueResult[] = [];
    for(const queue of queues) {
        const mappings = await lambda.listEventSourceMappings(queue.value!);
        let queueCommit: string | null = null;
        for(const m of mappings) {
            const parts = m.functionArn.split(':');
            if (parts.length === 8) {
                logger.verbose(`   - Lambda alias '${parts[7]}' active on ${queue.name}`);
                activeCommits.set(parts[7], true);
                queueCommit = parts[7];

                if (!commitStages.has(parts[7])) {
                    commitStages.set(parts[7], []);
                }
            }
        }
        queueResults.push({ name: queue.name, commit: queueCommit });
    }

    // ── Phase 3: Clean Lambda aliases & versions ──────────────────────
    const functionResults: CleanFunctionResult[] = [];
    for(const f of functions) {
        const functionName = f.value!;
        const activeVersions = new Map<string, boolean>();
        let aliasesRemoved = 0, versionsRemoved = 0, activeCount = 0;

        const aliases = await lambda.listAliases(functionName);
        for(const a of aliases) {
            if (activeCommits.has(a.alias)) {
                logger.verbose(`   - Active alias '${a.alias}' on ${functionName}`);
                activeVersions.set(a.version, true);
                activeCount++;
            } else {
                logger.verbose(`   - ${dryRun ? 'WOULD delete' : 'Deleted'} alias '${a.alias}' from ${functionName}`);
                if (!dryRun) await lambda.deleteAlias(functionName, a.alias);
                deletedAliases++;
                aliasesRemoved++;
            }
        }

        const versions = await lambda.listVersions(functionName);
        for(const v of versions) {
            if (v.version === '$LATEST') {
                continue;
            }
            if (activeVersions.has(v.version)) {
                logger.verbose(`   - Active version '${v.version}' on ${functionName}`);
            } else {
                logger.verbose(`   - ${dryRun ? 'WOULD delete' : 'Deleted'} version '${v.version}' from ${functionName}`);
                if (!dryRun) await lambda.deleteVersion(functionName, v.version);
                deletedVersions++;
                versionsRemoved++;
            }
        }
        functionResults.push({ name: functionName, aliasesRemoved, versionsRemoved, activeCount });
    }

    // ── Phase 4: Clean worker aliases & versions ──────────────────────
    // Workers use stage-as-alias semantics. Aliases whose name is a configured stage are
    // active; everything else (including legacy `{app}-{commit}` aliases from PR #178) is
    // stale and removed. Versions stay if they are referenced by a stage alias OR fall
    // within the most-recent N versions per worker (rollback retention floor).
    const workerResults: CleanWorkerResult[] = [];
    for (const w of workers) {
        const functionName = w.value!;
        const activeAliases: string[] = [];
        const activeVersions = new Map<string, boolean>();
        let aliasesRemoved = 0, versionsRemoved = 0;

        const aliases = await lambda.listAliases(functionName);
        for (const a of aliases) {
            if (stageNames.has(a.alias)) {
                logger.verbose(`   - Active worker alias '${a.alias}' on ${functionName}`);
                activeVersions.set(a.version, true);
                activeAliases.push(a.alias);
            } else {
                logger.verbose(`   - ${dryRun ? 'WOULD delete' : 'Deleted'} stale worker alias '${a.alias}' from ${functionName}`);
                if (!dryRun) await lambda.deleteAlias(functionName, a.alias);
                deletedAliases++;
                aliasesRemoved++;
            }
        }

        const versions = await lambda.listVersions(functionName);
        const numericVersions = versions.filter(v => v.version !== '$LATEST');

        // Retention floor: keep the most recent N versions (highest numeric version IDs)
        // beyond what stage aliases pin. Gives rollback headroom when target version is
        // not currently stage-pinned.
        const sortedDescending = [...numericVersions].sort((a, b) => Number(b.version) - Number(a.version));
        const retained = new Set<string>(sortedDescending.slice(0, WORKER_VERSION_RETENTION).map(v => v.version));

        for (const v of numericVersions) {
            if (activeVersions.has(v.version) || retained.has(v.version)) {
                logger.verbose(`   - Keeping worker version '${v.version}' on ${functionName}`);
            } else {
                logger.verbose(`   - ${dryRun ? 'WOULD delete' : 'Deleted'} worker version '${v.version}' from ${functionName}`);
                if (!dryRun) await lambda.deleteVersion(functionName, v.version);
                deletedVersions++;
                versionsRemoved++;
            }
        }

        workerResults.push({ name: functionName, aliasesRemoved, versionsRemoved, activeAliases });
    }

    // ── Print summary ─────────────────────────────────────────────────

    // Active commits
    console.log(`\nActive commits:`);
    // Group by commit, show stages
    for (const [commit, stages] of commitStages) {
        const stageLabel = stages.length > 0 ? stages.join(', ') : 'sns';
        console.log(`  ${stageLabel.padEnd(20)} : ${commit}`);
    }

    // API Deployments
    if (apiResults.length > 0) {
        console.log(`\nAPI Deployments:`);
        for (const r of apiResults) {
            const activeLabel = r.activeStageLabels.length > 0
                ? `  ${r.activeCount} active (${r.activeStageLabels.sort().join(', ')})`
                : '';
            console.log(`  ${r.name.padEnd(40)} ${String(r.removed).padStart(3)} removed${activeLabel}`);
        }
    }

    // SNS Topics
    if (topicResults.length > 0) {
        console.log(`\nSNS Topics:`);
        for (const r of topicResults) {
            console.log(`  ${r.name.padEnd(45)} ${r.commit || 'none'}`);
        }
    }

    // SQS Queues
    if (queueResults.length > 0) {
        console.log(`\nSQS Queues:`);
        for (const r of queueResults) {
            console.log(`  ${r.name.padEnd(45)} ${r.commit || 'none'}`);
        }
    }

    // Lambda Functions
    if (functionResults.length > 0) {
        console.log(`\nLambda Functions:`);
        for (const r of functionResults) {
            console.log(`  ${r.name.padEnd(35)} ${String(r.aliasesRemoved).padStart(3)} aliases removed  ${String(r.versionsRemoved).padStart(3)} versions removed  ${r.activeCount} active`);
        }
    }

    // Workers
    if (workerResults.length > 0) {
        console.log(`\nWorkers:`);
        for (const r of workerResults) {
            const activeLabel = r.activeAliases.length > 0 ? r.activeAliases.sort().join(', ') : 'none';
            console.log(`  ${r.name.padEnd(35)} ${String(r.aliasesRemoved).padStart(3)} aliases removed  ${String(r.versionsRemoved).padStart(3)} versions removed  active: ${activeLabel}`);
        }
    }

    // Final summary
    const verb = dryRun ? 'Would remove' : 'Removed';
    console.log(`\nSummary${dryRunLabel}: ${verb} ${deletedDeployments} deployments, ${deletedAliases} aliases, ${deletedVersions} versions`);
    console.log();
    console.timeEnd("api cicd");
}

main().catch(err => {
    console.error(`\nClean failed: ${err.message || err}`);
    process.exit(1);
});
