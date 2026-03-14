import { EnvResult, APIResult, SNSResult, TwilioDeployResult } from './types';

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
    const successful = deployments.filter((d: any) => d.status === 'success');

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
    let processEnv = false;
    let processApi = true;
    let processSns = true;
    let processTwilioFlag = true;

    if (o.env) {
        processEnv = true;
        processApi = false;
        processSns = false;
        processTwilioFlag = false;
    } else if (o.api || o.sns) {
        processApi = processSns = false;
        processApi = !!o.api;
        processSns = !!o.sns;
        processTwilioFlag = false;
    }

    if (o.noTwilio) {
        processTwilioFlag = false;
    }

    if (processApi || processSns) {
        processEnv = true;
    }

    let apiFilter = '';
    if (o.apiFilter) {
        apiFilter = o.apiFilter as string;
    }

    // Build scope label
    const scopeParts: string[] = [];
    if (processEnv && !processApi && !processSns) scopeParts.push('Environment only');
    else {
        if (processApi) scopeParts.push(apiFilter ? `API (${apiFilter})` : 'API');
        if (processSns) scopeParts.push('SNS');
        if (processTwilioFlag) scopeParts.push('Twilio');
        if (scopeParts.length === 0) scopeParts.push('Environment only');
        else scopeParts.unshift('Environment');
    }

    // Display confirmation
    if (!o.noHeader) printHeader();
    console.log(`Rollback Summary:`);
    console.log(`  Stage:    ${stage}`);
    console.log(`  Current:  ${current.ref}  (deployed ${current.createdAt})`);
    console.log(`  Target:   ${target.ref}  (deployed ${target.createdAt})`);
    console.log(`  Scope:    ${scopeParts.join(' + ')}`);
    console.log();

    const answer = await prompt(`Proceed with rollback? (y/N) `);
    if (answer !== 'y' && answer !== 'yes') {
        console.log('Rollback aborted.');
        process.exit(0);
    }

    // Execute rollback
    const commit = target.ref;
    const appAlias = `${app}-${commit}`;

    console.time("rollback");
    console.log(`\nRolling back to commit '${commit}' on '${stage}' stage...`);

    // Create GitHub deployment for the rollback
    let ghDeployment: any = null;
    ghDeployment = github.createDeployment(repo, commit, stage, `Rollback ${appAlias} on ${stage}`);
    if (ghDeployment) {
        github.updateDeploymentStatus(repo, ghDeployment.id, 'in_progress', `Rolling back to ${appAlias}`);
    }

    let envResults: EnvResult[] | null = null;
    let apiResults: APIResult | null = null;
    let snsResults: SNSResult | null = null;
    let twilioResult: TwilioDeployResult | null = null;

    try {
        if (processEnv) {
            envResults = await cicd.processFunctionEnvironmentVars();
        }

        if (processApi) {
            apiResults = await cicd.processApiGateway(stage, appAlias, commit, apiFilter);
        }

        if (processSns) {
            snsResults = await cicd.processSNS(stage, appAlias, commit);
        }

        if (processTwilioFlag) {
            twilioResult = await cicd.processTwilio(stage);
        }
    } catch (err: any) {
        if (ghDeployment) {
            github.updateDeploymentStatus(repo, ghDeployment.id, 'failure', err.message || 'Rollback failed');
        }
        throw err;
    }

    // ── Print summary ─────────────────────────────────────────────────

    if (envResults && envResults.length > 0) {
        console.log(`\nEnvironment Variables:`);
        for (const r of envResults) {
            const status = r.updated ? `${r.varCount} vars` : 'skipped';
            console.log(`  ${r.name.padEnd(40)} ${status}`);
        }
    }

    if (apiResults && apiResults.functions.length > 0) {
        console.log(`\nAPI Functions:`);
        for (const r of apiResults.functions) {
            const versionLabel = r.version ? `v${r.version}` : '';
            console.log(`  ${r.name.padEnd(40)} ${r.action.padEnd(10)} ${versionLabel}`);
        }
    }

    if (apiResults && apiResults.apis.length > 0) {
        console.log(`\nAPI Deployments:`);
        for (const r of apiResults.apis) {
            console.log(`  ${r.name.padEnd(40)} deployment ${r.deployment.padEnd(10)} stage ${r.stage.padEnd(10)} mapping ${r.mapping}`);
        }
    }

    if (snsResults && snsResults.functions.length > 0) {
        console.log(`\nSNS Functions:`);
        for (const r of snsResults.functions) {
            const versionLabel = r.version ? `v${r.version}` : '';
            console.log(`  ${r.name.padEnd(40)} ${r.action.padEnd(10)} ${versionLabel}`);
        }
    }

    if (snsResults && snsResults.subscriptions.length > 0) {
        console.log(`\nSNS Subscriptions:`);
        for (const r of snsResults.subscriptions) {
            if (r.action === 'skipped') {
                console.log(`  ${r.name.padEnd(40)} skipped`);
            } else {
                const oldLabel = r.oldRemoved && r.oldRemoved > 0 ? `  ${r.oldRemoved} old removed` : '';
                console.log(`  ${r.name.padEnd(40)} subscribed${oldLabel}`);
            }
        }
    }

    if (twilioResult) {
        console.log(`\nTwilio:`);
        const twilioLabel = twilioResult.messagingSid;
        console.log(`  ${twilioLabel.padEnd(40)} ${twilioResult.webhookUrl}`);
    }

    // Summary line
    const parts: string[] = [];
    if (envResults) {
        const updated = envResults.filter(r => r.updated).length;
        parts.push(`${updated} functions configured`);
    }
    if (apiResults) {
        const created = apiResults.functions.filter(r => r.action === 'created').length;
        const existing = apiResults.functions.filter(r => r.action === 'exists').length;
        parts.push(`${apiResults.apis.length} APIs deployed (${created} new, ${existing} existing)`);
    }
    if (snsResults) {
        const subscribed = snsResults.subscriptions.filter(r => r.action === 'subscribed').length;
        const skipped = snsResults.subscriptions.filter(r => r.action === 'skipped').length;
        if (subscribed > 0 || skipped > 0) {
            parts.push(`${subscribed} topics subscribed${skipped > 0 ? `, ${skipped} skipped` : ''}`);
        }
    }
    if (twilioResult) {
        parts.push(`Twilio webhook ${twilioResult.action}`);
    }
    console.log(`\nRollback complete: ${parts.join(', ')}`);

    // Update GitHub deployment status
    if (ghDeployment) {
        github.updateDeploymentStatus(repo, ghDeployment.id, 'success', `Rolled back ${appAlias} on ${stage}: ${parts.join(', ')}`);
    }

    console.log();
    console.timeEnd("rollback");
}

main();
