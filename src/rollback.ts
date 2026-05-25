import { EnvResult, APIResult, SNSResult, SQSResult, WorkerResult, FargateDeployResult, WebResult } from './types';
import { printDeploymentSummary } from './shared/summary';
import { resolveScope, scopeLabel, deployTargetLabel } from './shared/scope';
import { loadPlugins } from './shared/plugins';
import { runPlugins } from './shared/plugin-runner';
import { PluginResult } from './shared/plugin';

import * as verify from './shared/verify';
import * as cicd from './shared/cicd';
import * as options from './shared/options';
import * as credentials from './shared/credentials';
import * as logger from './shared/logger';
import * as github from './shared/github';
import { printHeader } from './shared/header';
import { prompt } from './shared/prompt';
import { getCommitSubject } from './shared/utils';

// When no commit is given, let the user pick a target from the rollback window.
// `current` (window[0]) is excluded since you can't roll back to what's live.
// Non-interactive stdin (CI / piped) falls back to the most recent prior
// deployment, preserving the previous no-arg behavior.
async function selectRollbackTarget(stage: string, window: any[], current: any): Promise<any> {
    const candidates = window.slice(1);
    if (!process.stdin.isTTY) {
        return candidates[0];
    }
    console.log(`Rollback targets for '${stage}'  (current: ${current.ref}, deployed ${current.createdAt}):\n`);
    candidates.forEach((d: any, i: number) => {
        const desc = d.description ? `  ${d.description}` : '';
        console.log(`  ${i + 1}) ${d.ref}  ${d.createdAt}${desc}`);
    });
    console.log();
    const sel = await prompt(`Select a deployment to roll back to [1-${candidates.length}] (default 1), or q to cancel: `);
    if (sel === 'q' || sel === 'quit') {
        console.log('Rollback aborted.');
        process.exit(0);
    }
    const idx = sel === '' ? 0 : parseInt(sel, 10) - 1;
    if (Number.isNaN(idx) || idx < 0 || idx >= candidates.length) {
        console.error(`Invalid selection '${sel}'.`);
        process.exit(1);
    }
    return candidates[idx];
}

async function main(): Promise<void> {
    await credentials.validateCredentials();

    let args = process.argv.slice(2);
    const o = options.getOptions(args);
    args = options.stripOptions(args);

    if (o.verbose) {
        logger.setVerbose(true);
        logger.log('Verbose mode enabled');
    }

    if (args.length < 1 || args.length > 2) {
        console.log(`rollback <stage> [commit]`);
        process.exit(0);
    }

    const stage = args[0];
    const targetCommit = args[1] || null;

    const app = await cicd.getConfig("app");
    const repo = await cicd.getConfig("repo");

    if (!repo) {
        console.error(`Error: 'repo' must be configured in cicd.json for rollback (deployment history is sourced from GitHub)`);
        process.exit(1);
    }

    // Validate stage exists
    await cicd.setStageConfig(stage);
    const production = !!(await cicd.getCurrentStageConfig()).production;

    // Read keep window (rollback window). The keep set IS the rollback window — any
    // commit not in the last N successful deployments is unrecoverable because
    // `clean --keep=N` deletes its artifacts.
    const keepN = o.keep ? Number(o.keep) : 5;
    if (!Number.isFinite(keepN) || keepN < 1) {
        console.error(`Error: --keep must be a positive integer (got '${o.keep}')`);
        process.exit(1);
    }

    // Fetch deployment history (pull more than N to keep filtering headroom)
    const deployments = github.listDeployments(repo, stage, Math.max(10, keepN * 4));
    const successful = deployments.filter((d: any) => d.status === 'success' || d.status === 'inactive');

    if (successful.length === 0) {
        console.error(`Error: No successful deployments found for stage '${stage}'.`);
        process.exit(1);
    }

    // Keep window for this stage: first N successful deployments.
    const window = successful.slice(0, keepN);
    const windowRefs = new Set(window.map((d: any) => d.ref));

    if (window.length < 2 && !targetCommit) {
        console.error(`Error: No prior successful deployment found for stage '${stage}' to rollback to (window size = ${window.length}).`);
        process.exit(1);
    }

    const current = window[0];
    let target: any;

    if (!o.noHeader) printHeader();

    if (targetCommit) {
        if (!windowRefs.has(targetCommit)) {
            console.error(`Error: Commit '${targetCommit}' is outside the rollback window for stage '${stage}' (keep window = N=${keepN}).`);
            console.error(`\nRecoverable commits (in window):`);
            for (const d of window) {
                console.error(`  ${d.ref}  ${d.createdAt}  ${d.description}`);
            }
            process.exit(1);
        }
        target = window.find((d: any) => d.ref === targetCommit);
        if (target.ref === current.ref) {
            console.error(`Error: Commit '${targetCommit}' is already the current deployment.`);
            process.exit(1);
        }
    } else {
        target = await selectRollbackTarget(stage, window, current);
    }

    // Determine scope
    const plugins = await loadPlugins();
    const scope = resolveScope(o, plugins);
    const { processEnv, processApi, processSns, processSqs, processWorkers, processWeb, apiFilter, webFilter, disabledPlugins } = scope;
    const dryRun = !!o.dryRun;

    // Display confirmation
    const dryRunLabel = dryRun ? ' [DRY RUN]' : '';
    console.log(`Rollback Summary${dryRunLabel}:`);
    console.log(`  Stage:    ${stage}`);
    console.log(`  Current:  ${current.ref}  (deployed ${current.createdAt})`);
    console.log(`  Target:   ${target.ref}  (deployed ${target.createdAt})`);
    console.log(`  Window:   ${window.length} of ${keepN} kept`);
    console.log(`  Scope:    ${scopeLabel(scope)}`);
    console.log();

    if (!dryRun) {
        const question = production
            ? `Roll back PRODUCTION stage '${stage}'? (y/N) `
            : `Proceed with rollback? (y/N) `;
        const answer = await prompt(question);
        if (answer !== 'y' && answer !== 'yes') {
            console.log('Rollback aborted.');
            process.exit(0);
        }
    }

    // Execute rollback
    const commit = target.ref;
    const appAlias = `${app}-${commit}`;
    // Deployment description: explicit --description override, else the target
    // commit's subject line, else a generated fallback.
    const description = o.description || getCommitSubject(commit) || `Rollback ${appAlias} on ${stage}`;
    const computeMode = (await cicd.getConfig("computeMode")) || 'lambda';

    // Safety check: verify rollback target aliases exist (Lambda mode only)
    if (computeMode !== 'fargate') {
        const { valid, warnings } = await cicd.validateRollbackTarget(appAlias, stage, commit);
        if (!valid) {
            console.log(`\nWARNING: Some Lambda aliases for '${appAlias}' are missing:`);
            for (const w of warnings) {
                console.log(`  ${w}`);
            }
            if (!dryRun) {
                const proceed = await prompt(`Continue anyway? (y/N) `);
                if (proceed !== 'y' && proceed !== 'yes') {
                    console.log('Rollback aborted.');
                    process.exit(0);
                }
            }
        }
    }

    console.time("rollback");
    const exportsList = (await cicd.getConfig('exports')) || [];
    const workersList = (await cicd.getConfig('workers')) || [];
    const targetLabel = deployTargetLabel(scope, {
        computeMode,
        exportTypes: exportsList.map(e => e.type),
        hasWorkers: workersList.length > 0,
    });
    console.log(`\nRolling back to commit '${commit}' on '${stage}' stage [${targetLabel}]${dryRunLabel}...`);

    // Create GitHub deployment for the rollback (skip in dry-run)
    let ghDeployment: any = null;
    if (!dryRun) {
        ghDeployment = github.createDeployment(repo, commit, stage, description, {
            productionEnvironment: production,
        });
        if (ghDeployment) {
            github.updateDeploymentStatus(repo, ghDeployment.id, 'in_progress', `Rolling back to ${appAlias}`);
        }
    }

    if (computeMode === 'fargate') {
        // ── Fargate rollback flow ────────────────────────────────────
        try {
            const result: FargateDeployResult = await cicd.processFargateDeploy(stage, commit);

            console.log(`\nFargate Rollback:`);
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
            } else if (!result.serviceStable) {
                console.log(`\n  WARNING: Service did not stabilize within timeout. Check ECS console.`);
                if (result.stoppedTaskReasons?.length) {
                    for (const reason of result.stoppedTaskReasons) {
                        console.log(`    - ${reason}`);
                    }
                }
            }

            const rollbackStatus = result.deploymentFailed ? 'failure' : 'success';
            const summary = result.deploymentFailed
                ? `Fargate rollback failed for commit ${commit}`
                : `Fargate service rolled back to commit ${commit}`;
            console.log(`\nRollback complete: ${summary}`);

            if (ghDeployment) {
                github.updateDeploymentStatus(repo, ghDeployment.id, rollbackStatus, `Rolled back ${appAlias} on ${stage}: ${summary}`);
            }
        } catch (err: any) {
            if (ghDeployment) {
                github.updateDeploymentStatus(repo, ghDeployment.id, 'failure', err.message || 'Rollback failed');
            }
            throw err;
        }

        console.log();
        console.timeEnd("rollback");
        return;
    }

    // ── Lambda rollback flow (existing behavior) ────────────────────

    let envResults: EnvResult[] | null = null;
    let apiResults: APIResult | null = null;
    let snsResults: SNSResult | null = null;
    let sqsResults: SQSResult | null = null;
    let workerResults: WorkerResult | null = null;
    let webResults: WebResult | null = null;
    let pluginResults: PluginResult[] = [];

    try {
        if (processEnv) {
            envResults = await cicd.processFunctionEnvironmentVars(dryRun);
        }

        if (processApi) {
            apiResults = await cicd.processApiGateway(stage, appAlias, commit, apiFilter, dryRun);
        }

        if (processSns) {
            snsResults = await cicd.processSNS(stage, appAlias, commit, dryRun);
        }

        if (processSqs) {
            sqsResults = await cicd.processSQS(stage, appAlias, commit, dryRun);
        }

        if (processWorkers) {
            workerResults = await cicd.processWorkers(stage, commit, dryRun);
        }

        if (processWeb) {
            webResults = await cicd.processWebRollback(stage, commit, webFilter, dryRun);
        }

        if (plugins.length > 0) {
            const currentStageConfig = await cicd.getCurrentStageConfig();
            pluginResults = await runPlugins('rollback', stage, currentStageConfig, dryRun, disabledPlugins);
        }
    } catch (err: any) {
        if (ghDeployment) {
            github.updateDeploymentStatus(repo, ghDeployment.id, 'failure', err.message || 'Rollback failed');
        }
        throw err;
    }

    // ── Print summary ─────────────────────────────────────────────────

    const parts = printDeploymentSummary({ env: envResults, api: apiResults, sns: snsResults, sqs: sqsResults, workers: workerResults, web: webResults, pluginResults });
    console.log(`\nRollback complete: ${parts.join(', ')}`);

    // Verify rollback (skip in dry-run)
    if (!dryRun) {
        const verifyResult = await verify.verifyDeployment(stage, appAlias, commit);
        verify.printVerificationResult(verifyResult);
    }

    // Update GitHub deployment status
    if (ghDeployment) {
        github.updateDeploymentStatus(repo, ghDeployment.id, 'success', `Rolled back ${appAlias} on ${stage}: ${parts.join(', ')}`);
    }

    console.log();
    console.timeEnd("rollback");
}

main().catch(err => {
    console.error(`\nRollback failed: ${err.message || err}`);
    process.exit(1);
});
