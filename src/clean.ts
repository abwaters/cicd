import { ExportConfig, FunctionConfig, WorkerFunctionConfig, StageConfig, CleanApiResult, CleanTopicResult, CleanQueueResult, CleanFunctionResult, CleanWorkerResult, CleanEcrResult } from './types';

import * as sns from './shared/sns';
import * as lambda from './shared/lambda';
import * as apigw from './shared/apigw';
import * as ecs from './shared/ecs';
import * as ecr from './shared/ecr';
import * as cicd from './shared/cicd';
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

    const account = await cicd.getConfig("account");
    const region = await cicd.getConfig("region");

    console.time("api cicd");
    if (!o.noHeader) printHeader();

    const computeMode = (await cicd.getConfig("computeMode")) || 'lambda';

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

                const revisions: string[] = await ecs.listTaskDefinitionRevisions(taskFamily);
                let deregistered = 0;
                for (const rev of revisions) {
                    if (rev !== activeTaskDefArn) {
                        logger.verbose(`   - Deregistering ${rev}`);
                        await ecs.deregisterTaskDefinition(rev);
                        deregistered++;
                    } else {
                        logger.verbose(`   - Active: ${rev}`);
                    }
                }
                totalDeregistered += deregistered;
                const activeRevision = activeTaskDefArn.split(':').pop() || '?';
                const stageLabel = info.stages.join(', ');
                console.log(`  ${taskFamily.padEnd(30)} active rev ${activeRevision}, ${deregistered} deregistered (${stageLabel})`);
            } catch (e: any) {
                const stageLabel = info.stages.join(', ');
                console.log(`  ${taskFamily.padEnd(30)} error: ${e.message} (${stageLabel})`);
            }
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
                    const result = await ecr.batchDeleteImages(repositoryName, toDelete);
                    totalEcrDeleted = result.deleted;
                    totalEcrFailures = result.failures;
                    console.log(`  ${repositoryName.padEnd(30)} ${totalEcrDeleted} deleted, ${activeCount} active (${activeTagList})`);
                    if (totalEcrFailures > 0) {
                        console.log(`  ${' '.padEnd(30)} ${totalEcrFailures} failures`);
                    }
                } else {
                    console.log(`  ${repositoryName.padEnd(30)} no unused images, ${activeCount} active (${activeTagList})`);
                }
            } catch (e: any) {
                console.log(`  error: ${e.message}`);
            }
        }

        console.log(`\nSummary: Deregistered ${totalDeregistered} task definition revisions, deleted ${totalEcrDeleted} ECR images`);
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

    // ── Phase 1: Scan API stages & clean deployments ──────────────────
    for(const api of apis) {
        const apiId = api.value!;
        const stages = await apigw.listStages(apiId);
        const activeDeployments = new Map<string, string[]>();
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
        }

        const deployments = await apigw.listDeployments(apiId);
        let removed = 0;
        let activeCount = 0;
        const activeStageLabels: string[] = [];
        for(const d of deployments) {
            if (!activeDeployments.has(d.id!)) {
                logger.verbose(`   - Deployment '${d.id}' deleted from ${api.name}`);
                await apigw.deleteDeployment(apiId, d.id!);
                deletedDeployments++;
                removed++;
            } else {
                const stageNames = activeDeployments.get(d.id!)!;
                logger.verbose(`   - Deployment '${d.id}' active (${stageNames.join(', ')})`);
                activeCount++;
                activeStageLabels.push(stageNames.sort().join('/'));
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
                logger.verbose(`   - Deleted alias '${a.alias}' from ${functionName}`);
                await lambda.deleteAlias(functionName, a.alias);
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
                logger.verbose(`   - Deleted version '${v.version}' from ${functionName}`);
                await lambda.deleteVersion(functionName, v.version);
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
                logger.verbose(`   - Deleted stale worker alias '${a.alias}' from ${functionName}`);
                await lambda.deleteAlias(functionName, a.alias);
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
                logger.verbose(`   - Deleted worker version '${v.version}' from ${functionName}`);
                await lambda.deleteVersion(functionName, v.version);
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
    console.log(`\nSummary: Removed ${deletedDeployments} deployments, ${deletedAliases} aliases, ${deletedVersions} versions`);
    console.log();
    console.timeEnd("api cicd");
}

main();
