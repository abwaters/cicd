import { ExportConfig, FunctionConfig, StageConfig, CleanApiResult, CleanTopicResult, CleanFunctionResult } from './types';

const sns = require('./shared/sns');
const lambda = require('./shared/lambda');
const apigw = require('./shared/apigw');
const ecs = require('./shared/ecs');
const cicd = require('./shared/cicd');
const credentials = require('./shared/credentials');
const options = require('./shared/options');
const logger = require('./shared/logger');
const { printHeader } = require('./shared/header');

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
        console.log(`Cleaning old Fargate task definition revisions...`);
        const fargateConfig = await cicd.resolveFargateConfig();
        const stages: StageConfig[] = await cicd.getConfig("stages");
        let totalDeregistered = 0;

        console.log(`\nTask Definition Cleanup:`);
        for (const stage of stages) {
            if (!stage.service || !stage.taskFamily) {
                console.log(`  ${stage.stage.padEnd(15)} not configured for fargate`);
                continue;
            }

            try {
                const serviceInfo = await ecs.describeService(fargateConfig.cluster, stage.service);
                const activeTaskDefArn = serviceInfo.taskDefinitionArn;

                const revisions: string[] = await ecs.listTaskDefinitionRevisions(stage.taskFamily);
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
                console.log(`  ${stage.stage.padEnd(15)} ${stage.taskFamily.padEnd(25)} active rev ${activeRevision}, ${deregistered} deregistered`);
            } catch (e: any) {
                console.log(`  ${stage.stage.padEnd(15)} error: ${e.message}`);
            }
        }

        console.log(`\nSummary: Deregistered ${totalDeregistered} task definition revisions`);
        console.log();
        console.timeEnd("api cicd");
        return;
    }

    // ── Lambda clean flow (existing behavior) ───────────────────────
    console.log(`Preparing clean api gateway deployments and lambda aliases/versions...`);

    // get list of exports from cloudformation
    const apis: ExportConfig[] = await cicd.getExportsByType('api');
    const topics: ExportConfig[] = await cicd.getExportsByType('sns');
    const apiFunctions: FunctionConfig[] = await cicd.getLambdaExports('api');
    const snsFunctions: FunctionConfig[] = await cicd.getLambdaExports('sns');
    const functions = [...apiFunctions,...snsFunctions];
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
            const commit = s.variables.Commit;
            activeCommits.set(commit, true);

            // Track commit -> stages mapping
            if (!commitStages.has(commit)) {
                commitStages.set(commit, []);
            }
            if (!commitStages.get(commit)!.includes(s.stageName)) {
                commitStages.get(commit)!.push(s.stageName);
            }

            // Accumulate stage names per deployment (fixes bug where second stage replaced first)
            if (!activeDeployments.has(s.deploymentId)) {
                activeDeployments.set(s.deploymentId, [s.stageName]);
            } else {
                activeDeployments.get(s.deploymentId)!.push(s.stageName);
            }
        }

        const deployments = await apigw.listDeployments(apiId);
        let removed = 0;
        let activeCount = 0;
        const activeStageLabels: string[] = [];
        for(const d of deployments) {
            if (!activeDeployments.has(d.id)) {
                logger.verbose(`   - Deployment '${d.id}' deleted from ${api.name}`);
                await apigw.deleteDeployment(apiId, d.id);
                deletedDeployments++;
                removed++;
            } else {
                const stageNames = activeDeployments.get(d.id)!;
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
        const subscriptions = await sns.listSubscriptionsByTopic(topic.value);
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

    // Lambda Functions
    if (functionResults.length > 0) {
        console.log(`\nLambda Functions:`);
        for (const r of functionResults) {
            console.log(`  ${r.name.padEnd(35)} ${String(r.aliasesRemoved).padStart(3)} aliases removed  ${String(r.versionsRemoved).padStart(3)} versions removed  ${r.activeCount} active`);
        }
    }

    // Final summary
    console.log(`\nSummary: Removed ${deletedDeployments} deployments, ${deletedAliases} aliases, ${deletedVersions} versions`);
    console.log();
    console.timeEnd("api cicd");
}

main();
