import {
    StageConfig,
    ExportConfig,
    FunctionConfig,
    AliasInfo,
    VersionListItem,
    InfoStageEntry,
    InfoTopicResult,
    InfoTwilioResult,
    InfoGitHubResult,
    GitHubDeployment
} from './types';

import * as options from './shared/options';
import * as cicd from './shared/cicd';
import * as lambda from './shared/lambda';
import * as apigw from './shared/apigw';
import * as sns from './shared/sns';
import * as twilio from './shared/twilio';
import * as credentials from './shared/credentials';
import * as logger from './shared/logger';
import * as github from './shared/github';
import * as ecs from './shared/ecs';
import { printHeader } from './shared/header';

async function main(): Promise<void> {
    // Validate AWS credentials before proceeding
    await credentials.validateCredentials();

    const account = await cicd.getConfig("account");
    const region = await cicd.getConfig("region");
    let args = process.argv.slice(2);
    const o = options.getOptions(args);
    args = options.stripOptions(args);

    // Set verbose mode if requested
    if (o.verbose) {
        logger.setVerbose(true);
        logger.log('Verbose mode enabled');
    }

    console.time("api cicd");
    if (!o.noHeader) printHeader();

    const computeMode = (await cicd.getConfig("computeMode")) || 'lambda';
    const stages: StageConfig[] = await cicd.getConfig("stages");

    if (computeMode === 'fargate') {
        // ── Fargate info flow ────────────────────────────────────────
        const fargateConfig = await cicd.resolveFargateConfig();

        console.log(`Collecting Fargate service information...`);
        console.log(`\nStages:`);

        for (const stage of stages) {
            if (!stage.service || !stage.taskFamily) {
                console.log(`  ${stage.stage.padEnd(15)} not configured for fargate`);
                continue;
            }

            try {
                const serviceInfo = await ecs.describeService(fargateConfig.cluster, stage.service);
                const taskDef = await ecs.describeTaskDefinition(serviceInfo.taskDefinitionArn);
                const container = (taskDef.containerDefinitions || []).find((c: any) => c.name === fargateConfig.containerName);
                const imageTag = container?.image?.split(':')[1] || 'unknown';
                const commitEnv = (container?.environment || []).find((e: any) => e.name === 'COMMIT');
                const commit = commitEnv?.value || imageTag;

                console.log(`  ${stage.stage.padEnd(15)} ${commit}`);
                if (o.details) {
                    console.log(`    - service:    ${stage.service}`);
                    console.log(`    - task def:   ${serviceInfo.taskDefinitionArn}`);
                    console.log(`    - image:      ${container?.image || 'unknown'}`);
                    console.log(`    - desired:    ${serviceInfo.desiredCount}`);
                    console.log(`    - running:    ${serviceInfo.runningCount}`);
                    console.log(`    - status:     ${serviceInfo.status}`);
                }
            } catch (e: any) {
                console.log(`  ${stage.stage.padEnd(15)} error: ${e.message}`);
            }
        }

        // GitHub Deployments
        const repo = await cicd.getConfig("repo");
        if (repo) {
            const ghResults: InfoGitHubResult[] = [];
            for (const stage of stages) {
                const deployments: GitHubDeployment[] = github.listDeployments(repo, stage.stage, 5);
                if (deployments.length > 0) {
                    ghResults.push({ stage: stage.stage, deployments });
                }
            }
            if (ghResults.length > 0) {
                console.log(`\nGitHub Deployments:`);
                for (const r of ghResults) {
                    console.log(`  ${r.stage}:`);
                    for (const d of r.deployments) {
                        const ts = new Date(d.createdAt).toLocaleString();
                        console.log(`    ${d.ref.padEnd(10)} ${d.status.padEnd(12)} ${ts}`);
                    }
                }
            }
        }

        console.log();
        console.timeEnd("api cicd");
        return;
    }

    // ── Lambda info flow (existing behavior) ────────────────────────
    console.log(`Collecting information for stages...`);
    const apis: ExportConfig[] = await cicd.getExportsByType('api');
    const topics: ExportConfig[] = await cicd.getExportsByType('sns');
    const topicFunctions: FunctionConfig[] = await cicd.getLambdaExports('sns');
    const apiFunctions: FunctionConfig[] = await cicd.getLambdaExports('api');
    const functions = [...apiFunctions,...topicFunctions];
    const stagesInfo: Record<string, InfoStageEntry> = {};
    const funcAliases = new Map<string, AliasInfo[]>();
    const funcVersions = new Map<string, VersionListItem[]>();
    for(const stage of stages) {
        stagesInfo[stage.stage] = {
            name: stage.stage,
            commits: {},
            details: [],
            functions: [],
        }
    }

    for(const api of apis) {
        const apiId = api.value!;
        logger.verbose(`   - Checking api ${api.name} [${apiId}]`);
        const apistages = await apigw.listStages(apiId);
        for(const s of apistages) {
            const name = api.name;
            const stagename = s.stageName!;
            const commit = s.variables!.Commit;
            const apiInfo = {
                name,
                stage: stagename,
                commit: s.variables!.Commit,
                functions: [] as any[]
            };
            if( !stagesInfo[stagename].commits.hasOwnProperty(commit) ) {
                stagesInfo[stagename].commits[commit] = 1;
            }else{
                stagesInfo[stagename].commits[commit]++ ;
            }
            stagesInfo[stagename].details.push(apiInfo);
            stagesInfo[stagename].functions = [];
            if( o.details ) {
                for(const f of functions) {
                    const finfo = {
                        name: f.value!,
                        commit: 'not deployed'
                    };
                    let aliases = funcAliases.get(f.value!);
                    if( !aliases ) {
                        aliases = await lambda.listAliases(f.value!);
                    }
                    const matchingAlias = aliases!.filter((a: AliasInfo) => a.alias==commit);
                    if( matchingAlias.length > 0 ) {
                        let versions = funcVersions.get(f.value!);
                        if( !versions ) {
                            versions = await lambda.listVersions(f.value!);
                        }
                        const v = versions!.filter((v: VersionListItem) => v.version==matchingAlias[0].version)[0];
                        finfo.commit = v.description;
                    }
                    stagesInfo[stagename].functions.push(finfo);
                }
            }
        }
    }

    // Collect SNS topic results
    const topicResults: InfoTopicResult[] = [];
    for(const topic of topics) {
        const subs = await sns.listSubscriptionsByTopic(topic.value!);
        let commit = '';
        for(const sub of subs) {
            if( sub.protocol === 'lambda' ) {
                const parts = sub.endpoint.split(':');
                if( parts.length === 8 ) {
                    commit = parts[7].split('-')[1];
                    logger.verbose(`   - Topic ${topic.name} subscribed to alias '${parts[7]}'`);
                    break;
                }
            }
        }
        topicResults.push({ name: topic.name, commit: commit || null });
    }

    // ── Print summary ─────────────────────────────────────────────────

    // Stages
    console.log(`\nStages:`);
    for(const [stageKey,stageEntry] of Object.entries(stagesInfo) ) {
        let commits = Object.keys(stageEntry.commits);
        commits = commits.map(c=>c.split('-')[1]);
        if( commits.length === 1 ) {
            console.log(`  ${stageKey.padEnd(15)} ${commits[0]}`);
        }else if( commits.length > 1 ) {
            console.log(`  ${stageKey.padEnd(15)} ${commits.join(', ')}`);
        }else{
            console.log(`  ${stageKey.padEnd(15)} not deployed`);
        }
        if( o.details ) {
            const funcs = stageEntry.functions;
            for(const f of funcs) {
                const funcName = f.name;
                const funcVersion = f.commit.includes('-')?f.commit.split('-')[1]:f.commit;
                console.log(`    - ${funcName.padEnd(35)} ${funcVersion}`);
            }
        }
    }

    // SNS Topics
    if (topicResults.length > 0) {
        console.log(`\nSNS Topics:`);
        for (const r of topicResults) {
            console.log(`  ${r.name.padEnd(45)} ${r.commit || 'none'}`);
        }
    }

    // Twilio Phone Numbers & Messaging Services
    const twilioResults: InfoTwilioResult[] = [];
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    if (accountSid && authToken) {
        for (const stage of stages) {
            if (stage.twilio) {
                let sid = stage.twilio.messagingSid;
                if (sid.startsWith('!')) {
                    sid = await cicd.resolveVariable(sid);
                    if (!sid) {
                        logger.verbose(`   - Could not resolve Twilio messagingSid for stage ${stage.stage}, skipping`);
                        continue;
                    }
                }
                if (twilio.isMessagingServiceSid(sid)) {
                    try {
                        const svc = await twilio.getMessagingService(accountSid, authToken, sid);
                        twilioResults.push({ stage: stage.stage, label: svc.friendlyName, webhookUrl: svc.inboundRequestUrl || 'not set', type: 'messaging-service' });
                    } catch (e: any) {
                        logger.verbose(`   - Error fetching messaging service ${sid}: ${e.message}`);
                        twilioResults.push({ stage: stage.stage, label: sid, webhookUrl: `error: ${e.message}`, type: 'messaging-service' });
                    }
                } else {
                    try {
                        const phone = await twilio.getPhoneNumber(accountSid, authToken, sid);
                        twilioResults.push({ stage: stage.stage, label: phone.phoneNumber, webhookUrl: phone.smsUrl, type: 'phone-number' });
                    } catch (e: any) {
                        logger.verbose(`   - Error fetching phone number ${sid}: ${e.message}`);
                        twilioResults.push({ stage: stage.stage, label: sid, webhookUrl: `error: ${e.message}`, type: 'phone-number' });
                    }
                }
            }
        }
    }
    if (twilioResults.length > 0) {
        console.log(`\nTwilio:`);
        for (const r of twilioResults) {
            const typeTag = r.type === 'messaging-service' ? '[svc] ' : '[num] ';
            console.log(`  ${r.stage.padEnd(15)} ${typeTag}${r.label.padEnd(20)} ${r.webhookUrl}`);
        }
    }

    // GitHub Deployments
    const repo = await cicd.getConfig("repo");
    if (repo) {
        const ghResults: InfoGitHubResult[] = [];
        for (const stage of stages) {
            const deployments: GitHubDeployment[] = github.listDeployments(repo, stage.stage, 5);
            if (deployments.length > 0) {
                ghResults.push({ stage: stage.stage, deployments });
            }
        }
        if (ghResults.length > 0) {
            console.log(`\nGitHub Deployments:`);
            for (const r of ghResults) {
                console.log(`  ${r.stage}:`);
                for (const d of r.deployments) {
                    const ts = new Date(d.createdAt).toLocaleString();
                    console.log(`    ${d.ref.padEnd(10)} ${d.status.padEnd(12)} ${ts}`);
                }
            }
        }
    }

    console.log();
    console.timeEnd("api cicd");
}

main();
