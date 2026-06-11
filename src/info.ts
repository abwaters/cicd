import {
    StageConfig,
    ExportConfig,
    FunctionConfig,
    WorkerFunctionConfig,
    AliasInfo,
    VersionListItem,
    InfoStageEntry,
    InfoTopicResult,
    InfoQueueResult,
    InfoWorkerResult,
    InfoGitHubResult,
    GitHubDeployment,
    BranchStatus
} from './types';

import * as options from './shared/options';
import * as cicd from './shared/cicd';
import * as awsContext from './shared/aws-context';
import * as lambda from './shared/lambda';
import * as apigw from './shared/apigw';
import * as sns from './shared/sns';
import * as credentials from './shared/credentials';
import * as logger from './shared/logger';
import * as github from './shared/github';
import * as ecs from './shared/ecs';
import * as s3 from './shared/s3';
import { printHeader } from './shared/header';
import { loadPlugins } from './shared/plugins';
import { runInfoPlugins } from './shared/plugin-runner';

async function main(): Promise<void> {
    // Validate AWS credentials before proceeding
    await credentials.validateCredentials();

    const account = await awsContext.getAccount();
    const region = await awsContext.getRegion();
    let args = process.argv.slice(2);
    const o = options.getOptions(args);
    options.enforceKnownOptions(o, 'info', ['details']);
    args = options.stripOptions(args);

    // --details is a legacy alias for --verbose; keep it working silently.
    if (o.details) o.verbose = true;

    // Set verbose mode if requested
    if (o.verbose) {
        logger.setVerbose(true);
        logger.log('Verbose mode enabled');
    }

    console.time("info");
    if (!o.noHeader) printHeader();

    const computeMode = (await cicd.getConfig("computeMode")) || 'lambda';
    const stages: StageConfig[] = await cicd.getConfig("stages");

    // Most-recent successful commit per stage (for drift detection). Empty when
    // 'repo' is not configured — drift checks then become no-ops.
    const recentByStage = new Map<string, string>();
    const recentSet = await cicd.buildKeepSet(1);
    for (const [stageName, commits] of recentSet) {
        const first = [...commits][0];
        if (first) recentByStage.set(stageName, first);
    }
    function driftLabel(stageName: string, liveCommit: string): string {
        const recent = recentByStage.get(stageName);
        if (!recent || !liveCommit || liveCommit === 'not deployed') return '';
        return liveCommit === recent ? '' : `  (drift: most recent kept = ${recent})`;
    }

    // Branch-status annotation: tip-of-main header + per-stage (main, current) /
    // (main, N behind) / (off main). Silently no-ops if repo or gh unavailable.
    const repo = await cicd.getConfig("repo");
    const branchCache = new Map<string, BranchStatus | null>();
    let mainTip: string | null = null;
    if (repo && github.isGhAvailable()) {
        mainTip = github.getBranchTip(repo, 'main');
    }
    function branchAnnotation(commit: string): string {
        if (!repo || !mainTip) return '';
        if (!commit || commit === 'not deployed' || commit.startsWith('error:')) return '';
        if (!/^[0-9a-f]{7,40}$/i.test(commit)) return '';
        if (!branchCache.has(commit)) {
            branchCache.set(commit, github.getCommitBranchStatus(repo, commit, 'main'));
        }
        const s = branchCache.get(commit);
        if (!s) return '';
        if (s.isMainTip) return '  (main, current)';
        if (s.onMain)    return `  (main, ${s.behindBy} behind)`;
        return '  (off main)';
    }

    // Compact-symbol equivalents used in the default (non-verbose) display.
    // Tracks whether any symbol was ever emitted so we know to print the legend.
    let symbolUsed = false;
    function branchSymbol(commit: string): string {
        if (!repo || !mainTip) return '';
        if (!commit || commit === 'not deployed' || commit.startsWith('error:')) return '';
        if (!/^[0-9a-f]{7,40}$/i.test(commit)) return '';
        if (!branchCache.has(commit)) {
            branchCache.set(commit, github.getCommitBranchStatus(repo, commit, 'main'));
        }
        const s = branchCache.get(commit);
        if (!s) return '';
        if (s.isMainTip) { symbolUsed = true; return '*'; }
        if (s.onMain)    { symbolUsed = true; return `↓${s.behindBy}`; }
        symbolUsed = true; return '!';
    }
    function driftSymbol(stageName: string, liveCommit: string): string {
        const recent = recentByStage.get(stageName);
        if (!recent || !liveCommit || liveCommit === 'not deployed') return '';
        if (liveCommit === recent) return '';
        symbolUsed = true;
        return '~';
    }
    function composeSymbols(stageName: string, commit: string): string {
        const parts = [branchSymbol(commit), driftSymbol(stageName, commit)].filter(Boolean);
        return parts.length ? ' ' + parts.join(' ') : '';
    }
    function printLegend(): void {
        if (!symbolUsed) return;
        console.log(`\nLegend: * main-current  ↓N N behind  ! off main  ~ drift`);
    }

    if (computeMode === 'fargate') {
        // ── Fargate info flow ────────────────────────────────────────
        const fargateConfig = await cicd.resolveFargateConfig();

        if (o.verbose) console.log(`Collecting Fargate service information...`);
        if (o.verbose && mainTip) console.log(`\nMain: ${mainTip}`);
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

                if (o.verbose) {
                    const counts = `desired:${serviceInfo.desiredCount} running:${serviceInfo.runningCount} pending:${serviceInfo.pendingCount}`;
                    console.log(`  ${stage.stage.padEnd(15)} ${commit.padEnd(12)} ${counts}${driftLabel(stage.stage, commit)}${branchAnnotation(commit)}`);
                    console.log(`    - service:    ${stage.service}`);
                    console.log(`    - task def:   ${serviceInfo.taskDefinitionArn}`);
                    console.log(`    - image:      ${container?.image || 'unknown'}`);
                    console.log(`    - status:     ${serviceInfo.status}`);
                } else {
                    console.log(`  ${stage.stage.padEnd(15)} ${commit}${composeSymbols(stage.stage, commit)}`);
                }
            } catch (e: any) {
                console.log(`  ${stage.stage.padEnd(15)} error: ${e.message}`);
            }
        }

        // GitHub Deployments (verbose only)
        if (o.verbose && repo) {
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

        if (!o.verbose) printLegend();
        console.log();
        console.timeEnd("info");
        return;
    }

    // ── Lambda info flow (existing behavior) ────────────────────────
    if (o.verbose) console.log(`Collecting information for stages...`);
    const apis: ExportConfig[] = await cicd.getExportsByType('api');
    const topics: ExportConfig[] = await cicd.getExportsByType('sns');
    const queues: ExportConfig[] = await cicd.getExportsByType('sqs');
    const topicFunctions: FunctionConfig[] = await cicd.getLambdaExports('sns');
    const apiFunctions: FunctionConfig[] = await cicd.getLambdaExports('api');
    const queueFunctions: FunctionConfig[] = await cicd.getLambdaExports('sqs');
    const functions = [...apiFunctions,...topicFunctions,...queueFunctions];
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
            if( o.verbose ) {
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

    // Collect SQS queue results
    const queueResults: InfoQueueResult[] = [];
    for(const queue of queues) {
        const mappings = await lambda.listEventSourceMappings(queue.value!);
        let commit = '';
        for(const m of mappings) {
            const parts = m.functionArn.split(':');
            if( parts.length === 8 ) {
                commit = parts[7].split('-')[1];
                logger.verbose(`   - Queue ${queue.name} mapped to alias '${parts[7]}'`);
                break;
            }
        }
        queueResults.push({ name: queue.name, commit: commit || null });
    }

    // Collect Worker results — workers use stage-as-alias semantics:
    // alias name == stage name; the version it points at carries the commit in its description.
    const stageNames = new Set(stages.map(s => s.stage));
    const workers: WorkerFunctionConfig[] = await cicd.getWorkers();
    const workerResults: InfoWorkerResult[] = [];
    for(const w of workers) {
        const aliases = await lambda.listAliases(w.value!);
        const versions = await lambda.listVersions(w.value!);
        const versionByNumber = new Map(versions.map(v => [v.version, v]));
        const commits: Record<string, string> = {};
        for(const a of aliases) {
            // Only show aliases that match a configured stage. Legacy `{app}-{commit}` aliases
            // (created by the prior worker scheme) are stale and will be removed by `clean`.
            if (!stageNames.has(a.alias)) continue;
            const v = versionByNumber.get(a.version);
            commits[a.alias] = (v?.description) || a.version;
        }
        workerResults.push({ name: w.value!, commits });
    }

    // Collect web export deployment state per stage. GitHub deployments are the
    // source of truth (recentByStage); the S3 live marker is a backup used when
    // GitHub is unavailable (no 'repo'), and a cross-check that flags drift when
    // the two disagree (e.g. S3 tampering or a half-failed deploy). Gathered
    // unconditionally (not just --verbose) so web-only stages are reflected in
    // the Stages summary instead of showing "not deployed".
    const app: string = await cicd.getConfig('app');
    const webExportsInfo: Array<{ name: string; distribution: string; perStage: Map<string, string>; notes: Map<string, string> }> = [];
    const webExports: ExportConfig[] = await cicd.getExportsByType('web');
    for (const w of webExports) {
        const distribution = w.distributionValue!;
        const perStage = new Map<string, string>();
        const notes = new Map<string, string>();
        for (const stage of stages) {
            if (w.stages && !w.stages.includes(stage.stage)) continue;
            const githubCommit = recentByStage.get(stage.stage);
            let markerCommit: string | undefined;
            try {
                const marker = await s3.getJson<{ commit?: string }>(w.value!, cicd.liveMarkerKey(stage.stage));
                markerCommit = marker?.commit;
            } catch (e: any) {
                notes.set(stage.stage, `  (marker read error: ${e.message})`);
            }
            const commit = githubCommit ?? markerCommit ?? 'not deployed';
            if (githubCommit && markerCommit && githubCommit !== markerCommit) {
                notes.set(stage.stage, `  (marker: ${markerCommit} — drift)`);
            }
            perStage.set(stage.stage, commit);
        }
        webExportsInfo.push({ name: w.name, distribution, perStage, notes });
    }

    // Normalize a stored commit key to the bare commit. API stages store the
    // `{app}-{commit}` stage variable; strip the app prefix (handles app names
    // that themselves contain hyphens). Web commits are already bare.
    function bareCommit(key: string): string {
        if (app && key.startsWith(app + '-')) return key.slice(app.length + 1);
        const i = key.indexOf('-');
        return i >= 0 ? key.slice(i + 1) : key;
    }

    // Aggregate the deployed bare commit(s) per stage across every concern
    // (API stages + web exports). Drives the Stages summary's deployed/not-deployed
    // decision and the displayed commit list.
    const commitsByStage = new Map<string, string[]>();
    for (const stage of stages) {
        const set = new Set<string>();
        for (const key of Object.keys(stagesInfo[stage.stage].commits)) {
            set.add(bareCommit(key));
        }
        for (const we of webExportsInfo) {
            const c = we.perStage.get(stage.stage);
            if (c && c !== 'not deployed' && !c.startsWith('error:')) set.add(c);
        }
        commitsByStage.set(stage.stage, [...set]);
    }

    // ── Print summary ─────────────────────────────────────────────────

    const widest = (names: string[]) => Math.max(0, ...names.map(n => n.length));

    // Stages
    if (o.verbose && mainTip) console.log(`\nMain: ${mainTip}`);
    console.log(`\nStages:`);
    for(const [stageKey,stageEntry] of Object.entries(stagesInfo) ) {
        let commits = commitsByStage.get(stageKey) || [];
        if (o.verbose) {
            if( commits.length === 1 ) {
                console.log(`  ${stageKey.padEnd(15)} ${commits[0]}${driftLabel(stageKey, commits[0])}${branchAnnotation(commits[0])}`);
            }else if( commits.length > 1 ) {
                // Mixed commits across this stage's APIs — flag any that disagree with most-recent kept.
                const recent = recentByStage.get(stageKey);
                const drift = recent && !commits.includes(recent) ? `  (drift: most recent kept = ${recent})` : '';
                const annotated = commits.map(c => `${c}${branchAnnotation(c)}`).join(', ');
                console.log(`  ${stageKey.padEnd(15)} ${annotated}${drift}`);
            }else{
                console.log(`  ${stageKey.padEnd(15)} not deployed`);
            }
            const funcs = stageEntry.functions;
            if (funcs.length > 0) {
                const funcWidth = widest(funcs.map(f => f.name));
                for(const f of funcs) {
                    const funcVersion = f.commit.includes('-')?f.commit.split('-')[1]:f.commit;
                    console.log(`    - ${f.name.padEnd(funcWidth)}  ${funcVersion}`);
                }
            }
        } else {
            if (commits.length === 1) {
                console.log(`  ${stageKey.padEnd(15)} ${commits[0]}${composeSymbols(stageKey, commits[0])}`);
            } else if (commits.length > 1) {
                const recent = recentByStage.get(stageKey);
                const driftMark = recent && !commits.includes(recent) ? ' ~' : '';
                const annotated = commits.map(c => `${c}${composeSymbols(stageKey, c)}`).join(', ');
                if (driftMark) symbolUsed = true;
                console.log(`  ${stageKey.padEnd(15)} ${annotated}${driftMark}`);
            } else {
                console.log(`  ${stageKey.padEnd(15)} not deployed`);
            }
        }
    }

    if (o.verbose) {
        // SNS Topics
        if (topicResults.length > 0) {
            console.log(`\nSNS Topics:`);
            const w = widest(topicResults.map(r => r.name));
            for (const r of topicResults) {
                const c = r.commit || '';
                console.log(`  ${r.name.padEnd(w)}  ${r.commit || 'none'}${branchAnnotation(c)}`);
            }
        }

        // SQS Queues
        if (queueResults.length > 0) {
            console.log(`\nSQS Queues:`);
            const w = widest(queueResults.map(r => r.name));
            for (const r of queueResults) {
                const c = r.commit || '';
                console.log(`  ${r.name.padEnd(w)}  ${r.commit || 'none'}${branchAnnotation(c)}`);
            }
        }

        // Workers
        if (workerResults.length > 0) {
            console.log(`\nWorkers:`);
            const w = widest(workerResults.map(r => r.name));
            for (const r of workerResults) {
                const aliasList = Object.keys(r.commits);
                const label = aliasList.length === 0
                    ? 'none'
                    : aliasList.map(a => `${a}=${r.commits[a]}${branchAnnotation(r.commits[a])}`).join(', ');
                console.log(`  ${r.name.padEnd(w)}  ${label}`);
            }
        }

        // Web (S3 + CloudFront) — reuse the state gathered above.
        if (webExportsInfo.length > 0) {
            console.log(`\nWeb:`);
            for (const we of webExportsInfo) {
                console.log(`  ${we.name}  (distribution ${we.distribution})`);
                for (const stage of stages) {
                    if (!we.perStage.has(stage.stage)) continue;
                    const commit = we.perStage.get(stage.stage)!;
                    const note = we.notes.get(stage.stage) ?? '';
                    console.log(`    ${stage.stage.padEnd(15)} ${commit}${note}${branchAnnotation(commit)}`);
                }
            }
        }

        // Plugin info — each plugin owns its own rendering
        const plugins = await loadPlugins();
        if (plugins.length > 0) {
            const pluginResults = await runInfoPlugins(stages);
            for (const r of pluginResults) {
                for (const line of r.summaryLines) {
                    console.log(line);
                }
            }
        }

        // GitHub Deployments
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
    } else {
        printLegend();
    }

    console.log();
    console.timeEnd("info");
}

main().catch(err => {
    console.error(`\nError: ${err.message || err}`);
    process.exit(1);
});
