import { EnvResult, APIResult, SNSResult, TwilioDeployResult, FargateDeployResult } from './types';
import { printDeploymentSummary } from './shared/summary';
import { resolveScope, scopeLabel } from './shared/scope';

const cicd = require('./shared/cicd');
const options = require("./shared/options");
const credentials = require('./shared/credentials');
const logger = require('./shared/logger');
const github = require('./shared/github');
const { printHeader } = require('./shared/header');
const readline = require('readline');

function prompt(question: string): Promise<string> {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise(resolve => {
        rl.question(question, (answer: string) => {
            rl.close();
            resolve(answer.trim().toLowerCase());
        });
    });
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

    // Fetch deployment history
    const deployments = github.listDeployments(repo, stage, 10);
    const successful = deployments.filter((d: any) => d.status === 'success' || d.status === 'inactive');

    if (successful.length < 2 && !targetCommit) {
        console.error(`Error: No prior successful deployment found for stage '${stage}' to rollback to.`);
        process.exit(1);
    }

    if (successful.length === 0) {
        console.error(`Error: No successful deployments found for stage '${stage}'.`);
        process.exit(1);
    }

    const current = successful[0];
    let target: any;

    if (targetCommit) {
        target = successful.find((d: any) => d.ref === targetCommit);
        if (!target) {
            console.error(`Error: Commit '${targetCommit}' not found in recent successful deployments for '${stage}'.`);
            console.error(`\nRecent successful deployments:`);
            for (const d of successful) {
                console.error(`  ${d.ref}  ${d.createdAt}  ${d.description}`);
            }
            process.exit(1);
        }
        if (target.ref === current.ref) {
            console.error(`Error: Commit '${targetCommit}' is already the current deployment.`);
            process.exit(1);
        }
    } else {
        target = successful[1];
    }

    // Determine scope
    const scope = resolveScope(o);
    const { processEnv, processApi, processSns, processTwilio, apiFilter } = scope;
    const dryRun = !!o.dryRun;

    // Display confirmation
    if (!o.noHeader) printHeader();
    const dryRunLabel = dryRun ? ' [DRY RUN]' : '';
    console.log(`Rollback Summary${dryRunLabel}:`);
    console.log(`  Stage:    ${stage}`);
    console.log(`  Current:  ${current.ref}  (deployed ${current.createdAt})`);
    console.log(`  Target:   ${target.ref}  (deployed ${target.createdAt})`);
    console.log(`  Scope:    ${scopeLabel(scope)}`);
    console.log();

    if (!dryRun) {
        const answer = await prompt(`Proceed with rollback? (y/N) `);
        if (answer !== 'y' && answer !== 'yes') {
            console.log('Rollback aborted.');
            process.exit(0);
        }
    }

    // Execute rollback
    const commit = target.ref;
    const appAlias = `${app}-${commit}`;
    const computeMode = (await cicd.getConfig("computeMode")) || 'lambda';

    console.time("rollback");
    console.log(`\nRolling back to commit '${commit}' on '${stage}' stage [${computeMode}]${dryRunLabel}...`);

    // Create GitHub deployment for the rollback (skip in dry-run)
    let ghDeployment: any = null;
    if (!dryRun) {
        ghDeployment = github.createDeployment(repo, commit, stage, `Rollback ${appAlias} on ${stage}`);
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

            if (!result.serviceStable) {
                console.log(`\n  WARNING: Service did not stabilize within timeout. Check ECS console.`);
            }

            const summary = `Fargate service rolled back to commit ${commit}`;
            console.log(`\nRollback complete: ${summary}`);

            if (ghDeployment) {
                github.updateDeploymentStatus(repo, ghDeployment.id, 'success', `Rolled back ${appAlias} on ${stage}: ${summary}`);
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
    let twilioResult: TwilioDeployResult | null = null;

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

        if (processTwilio) {
            twilioResult = await cicd.processTwilio(stage, dryRun);
        }
    } catch (err: any) {
        if (ghDeployment) {
            github.updateDeploymentStatus(repo, ghDeployment.id, 'failure', err.message || 'Rollback failed');
        }
        throw err;
    }

    // ── Print summary ─────────────────────────────────────────────────

    const parts = printDeploymentSummary({ env: envResults, api: apiResults, sns: snsResults, twilio: twilioResult });
    console.log(`\nRollback complete: ${parts.join(', ')}`);

    // Update GitHub deployment status
    if (ghDeployment) {
        github.updateDeploymentStatus(repo, ghDeployment.id, 'success', `Rolled back ${appAlias} on ${stage}: ${parts.join(', ')}`);
    }

    console.log();
    console.timeEnd("rollback");
}

main();
