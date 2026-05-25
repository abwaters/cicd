import { execSync } from 'child_process';
import { EnvResult, APIResult, SNSResult, SQSResult, WorkerResult, FargateDeployResult, WebResult } from './types';
import { printDeploymentSummary } from './shared/summary';
import { resolveScope, deployTargetLabel } from './shared/scope';
import { loadPlugins } from './shared/plugins';
import { runPlugins } from './shared/plugin-runner';
import { PluginResult } from './shared/plugin';

import * as verify from './shared/verify';
import * as cicd from './shared/cicd';
import * as options from './shared/options';
import * as credentials from './shared/credentials';
import * as logger from './shared/logger';
import * as github from './shared/github';
import { isNetworkError, describeNetworkError, getCommitSubject } from './shared/utils';
import { printHeader } from './shared/header';
import { prompt } from './shared/prompt';

function getCurrentCommit(): string {
    try {
        return execSync('git rev-parse --short HEAD', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    } catch (err: any) {
        console.error(`Failed to determine current commit: ${err.message || err}`);
        process.exit(1);
    }
}

// Track the active GitHub deployment so `main().catch()` can mark it failed
// if an error escapes every inner try/catch. Otherwise a transient failure
// during verify or summary leaves the deployment stuck at `in_progress`.
const cleanupContext: { repo?: string; ghDeployment?: { id: number } | null } = {};

function markDeploymentFailure(message: string): void {
    if (cleanupContext.repo && cleanupContext.ghDeployment) {
        try {
            github.updateDeploymentStatus(cleanupContext.repo, cleanupContext.ghDeployment.id, 'failure', message);
        } catch {
            // swallow — best-effort cleanup
        }
    }
}

async function main(): Promise<void> {
    // Validate AWS credentials before proceeding
    await credentials.validateCredentials();

    let args = process.argv.slice(2);
    const o = options.getOptions(args);
    args = options.stripOptions(args);

    // Set verbose mode if requested
    if (o.verbose) {
        logger.setVerbose(true);
        logger.log('Verbose mode enabled');
    }
    if( args.length < 1 || args.length > 2 ) {
        console.log(`deploy <stage> [commit]`);
        process.exit(0);
    }

    const plugins = await loadPlugins();
    const scope = resolveScope(o, plugins);
    const { processEnv, processApi, processSns, processSqs, processWorkers, processWeb, apiFilter, webFilter, disabledPlugins } = scope;
    const dryRun = !!o.dryRun;

    // TODO: formalize the cicd initialization...
    const stage = args[0];
    const commit = args[1] || getCurrentCommit();
    const app = await cicd.getConfig("app");
    const appAlias = `${app}-${commit}`;
    await cicd.setStageConfig(stage);

    console.time("deploy");
    if (!o.noHeader) printHeader();

    const computeMode = (await cicd.getConfig("computeMode")) || 'lambda';
    const repo = await cicd.getConfig("repo");

    // Production stages (production: true in cicd.json) flag the GitHub deployment
    // as a production_environment and require confirmation before deploying.
    const stageConfig = await cicd.getCurrentStageConfig();
    const production = !!stageConfig.production;

    // Deployment description: explicit --description override, else the commit's
    // subject line, else a generated fallback if git can't resolve the commit.
    const description = o.description || getCommitSubject(commit) || `Deploy ${appAlias} to ${stage}`;

    // Idempotency guard: if the requested commit is already the current
    // successful deployment for this stage, treat it as a no-op success
    // rather than re-running the pipeline. Skipped on --dry-run, when
    // --force is given, or when no `repo` is configured.
    if (repo && !dryRun && !o.force) {
        const recent = github.listDeployments(repo, stage, 10);
        const current = recent.find((d: any) => d.status === 'success');
        if (current && current.ref === commit) {
            const deployedAt = current.createdAt.slice(0, 16).replace('T', ' ') + ' UTC';
            console.log(`Commit '${commit}' is already deployed to '${stage}' (${deployedAt}).`);
            console.log(`No action needed. Use --force to redeploy.`);
            process.exit(0);
        }
    }

    // Production safety pin: confirm before touching a production stage. Bypassed
    // by --force and skipped on dry runs. Non-interactive sessions (CI/piped) must
    // pass --force rather than silently deploying to production.
    if (production && !dryRun && !o.force) {
        if (process.stdin.isTTY) {
            const answer = await prompt(`Deploy to PRODUCTION stage '${stage}'? (y/N) `);
            if (answer !== 'y' && answer !== 'yes') {
                console.log('Deploy aborted.');
                process.exit(0);
            }
        } else {
            console.error(`Refusing to deploy to PRODUCTION stage '${stage}' without confirmation. Re-run with --force.`);
            process.exit(1);
        }
    }

    // Transient environment: feature/PR deploys (commit not on the default branch)
    // are marked transient so GitHub auto-inactivates them in the Environments UI.
    // Explicit --transient / --no-transient override the branch-based auto-detection.
    let transient = false;
    if (o.noTransient) {
        transient = false;
    } else if (o.transient) {
        transient = true;
    } else if (repo && github.isGhAvailable()) {
        const status = github.getCommitBranchStatus(repo, commit, 'main');
        transient = status ? !status.onMain : false;
    }

    const dryRunLabel = dryRun ? ' [DRY RUN]' : '';
    const flagMarkers = `${production ? ' [production]' : ''}${transient ? ' [transient]' : ''}`;
    const exportsList = (await cicd.getConfig('exports')) || [];
    const workersList = (await cicd.getConfig('workers')) || [];
    const targetLabel = deployTargetLabel(scope, {
        computeMode,
        exportTypes: exportsList.map(e => e.type),
        hasWorkers: workersList.length > 0,
    });
    console.log(`Deploying commit '${commit}' to '${stage}' stage [${targetLabel}]${flagMarkers}${dryRunLabel}...`);

    // Create GitHub deployment if repo is configured (skip in dry-run)
    let ghDeployment: any = null;
    if (repo && !dryRun) {
        ghDeployment = github.createDeployment(repo, commit, stage, description, {
            productionEnvironment: production,
            transientEnvironment: transient,
        });
        if (ghDeployment) {
            github.updateDeploymentStatus(repo, ghDeployment.id, 'in_progress', `Deploying ${appAlias}`);
            cleanupContext.repo = repo;
            cleanupContext.ghDeployment = ghDeployment;
        }
    }

    if (computeMode === 'fargate') {
        // ── Fargate deploy flow ──────────────────────────────────────
        try {
            const result: FargateDeployResult = await cicd.processFargateDeploy(stage, commit);

            console.log(`\nFargate Deployment:`);
            console.log(`  Image:           ${result.image}`);
            console.log(`  Task Definition: ${result.taskDefinitionArn}`);
            console.log(`  Previous:        ${result.previousTaskDefinitionArn}`);
            console.log(`  Service Stable:  ${result.serviceStable ? 'yes' : 'no'}`);

            if (result.deploymentFailed) {
                console.log(`\n  FAILED: ${result.failureReason}`);
                if (result.stoppedTaskReasons?.length) {
                    for (const reason of result.stoppedTaskReasons) {
                        console.log(`    - ${reason}`);
                    }
                }
                if (result.rolledBack) {
                    console.log(`\n  Rolled back to previous task definition: ${result.previousTaskDefinitionArn}`);
                }
            } else if (!result.serviceStable) {
                console.log(`\n  WARNING: Service did not stabilize within timeout. Check ECS console.`);
                if (result.stoppedTaskReasons?.length) {
                    for (const reason of result.stoppedTaskReasons) {
                        console.log(`    - ${reason}`);
                    }
                }
            }

            const deployStatus = result.deploymentFailed ? 'failure' : 'success';
            const summary = result.deploymentFailed
                ? `Fargate deployment failed for commit ${commit}${result.rolledBack ? ' (rolled back)' : ''}`
                : `Fargate service updated to commit ${commit}`;
            console.log(`\nSummary: ${summary}`);

            if (repo && ghDeployment) {
                github.updateDeploymentStatus(repo, ghDeployment.id, deployStatus, `Deployed ${appAlias} to ${stage}: ${summary}`);
            }
        } catch (err: any) {
            if (repo && ghDeployment) {
                github.updateDeploymentStatus(repo, ghDeployment.id, 'failure', err.message || 'Deployment failed');
            }
            throw err;
        }

        console.log();
        console.timeEnd("deploy");
        return;
    }

    // ── Lambda deploy flow (existing behavior) ──────────────────────

    let envResults: EnvResult[] | null = null;
    let apiResults: APIResult | null = null;
    let snsResults: SNSResult | null = null;
    let sqsResults: SQSResult | null = null;
    let workerResults: WorkerResult | null = null;
    let webResults: WebResult | null = null;
    let pluginResults: PluginResult[] = [];

    try {
        if( processEnv ) {
            envResults = await cicd.processFunctionEnvironmentVars(dryRun);
        }

        if( processApi ) {
            apiResults = await cicd.processApiGateway(stage,appAlias,commit,apiFilter,dryRun);
        }

        if( processSns ) {
            snsResults = await cicd.processSNS(stage,appAlias,commit,dryRun);
        }

        if( processSqs ) {
            sqsResults = await cicd.processSQS(stage,appAlias,commit,dryRun);
        }

        if( processWorkers ) {
            workerResults = await cicd.processWorkers(stage,commit,dryRun);
        }

        if( processWeb ) {
            webResults = await cicd.processWeb(stage,appAlias,commit,webFilter,dryRun);
            // An empty web result means web exports exist but none apply to this
            // stage (processWeb already warned). Treat that as a failure — rather
            // than a phantom "success" deployment — when web is the only thing
            // this invocation could have done: either web was explicitly scoped,
            // or the repo configures nothing but web.
            const webOnlyRepo = exportsList.length > 0 && exportsList.every(e => e.type === 'web') && workersList.length === 0;
            if (webResults && webResults.exports.length === 0 && (!!o.web || !!webFilter || webOnlyRepo)) {
                throw new Error(`No web export applies to stage '${stage}' — nothing was deployed. Check the 'stages' lists on the web exports in cicd.json.`);
            }
        }

        if (plugins.length > 0) {
            const currentStageConfig = await cicd.getCurrentStageConfig();
            pluginResults = await runPlugins('deploy', stage, currentStageConfig, dryRun, disabledPlugins);
        }

        // ── Print summary ─────────────────────────────────────────────

        const parts = printDeploymentSummary({ env: envResults, api: apiResults, sns: snsResults, sqs: sqsResults, workers: workerResults, web: webResults, pluginResults });
        console.log(`\nSummary: ${parts.join(', ')}`);

        // Verify deployment (skip in dry-run)
        if (!dryRun) {
            const verifyResult = await verify.verifyDeployment(stage, appAlias, commit);
            verify.printVerificationResult(verifyResult);
        }

        // Update GitHub deployment status to success
        if (repo && ghDeployment) {
            github.updateDeploymentStatus(repo, ghDeployment.id, 'success', `Deployed ${appAlias} to ${stage}: ${parts.join(', ')}`);
        }
    } catch (err: any) {
        // Update GitHub deployment status to failure
        if (repo && ghDeployment) {
            github.updateDeploymentStatus(repo, ghDeployment.id, 'failure', err.message || 'Deployment failed');
        }
        throw err;
    }

    console.log();
    console.timeEnd("deploy");
}

main().catch(err => {
    // Safety net: if an error escaped every inner try/catch, still mark the
    // GitHub deployment failed so it doesn't sit at `in_progress` forever.
    markDeploymentFailure(err.message || 'Deployment failed');
    if (isNetworkError(err)) {
        console.error(`\nDeployment failed: ${describeNetworkError(err)}`);
    } else {
        console.error(`\nDeployment failed: ${err.message || err}`);
    }
    process.exit(1);
});
