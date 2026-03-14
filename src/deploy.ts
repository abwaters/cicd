import { EnvResult, APIResult, SNSResult, TwilioDeployResult } from './types';

const cicd = require('./shared/cicd');
const options = require("./shared/options");
const credentials = require('./shared/credentials');
const logger = require('./shared/logger');
const github = require('./shared/github');
const { printHeader } = require('./shared/header');

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
    if( args.length != 2 ) {
        console.log(`deploy <stage> <commit>`);
        process.exit(0);
    }

    let processEnv = false;
    let processApi: boolean = true;
    let processSns: boolean = true ;
    let processTwilioFlag = true;
    if( o.env ) {
        processEnv = true;
        processApi = false;
        processSns = false;
        processTwilioFlag = false;
    }else if( o.api || o.sns ) {
        processApi = processSns = false;
        processApi = !!o.api;
        processSns = !!o.sns;
        processTwilioFlag = false;
    }

    if( o.noTwilio ) {
        processTwilioFlag = false;
    }

    if( processApi || processSns ) {
        processEnv = true;
    }

    let apiFilter = '';
    if( o.apiFilter ) {
        apiFilter = o.apiFilter as string;
    }

    // TODO: formalize the cicd initialization...
    const stage = args[0];
    const commit = args[1];
    const app = await cicd.getConfig("app");
    const appAlias = `${app}-${commit}`;
    await cicd.setStageConfig(stage);

    console.time("api cicd");
    if (!o.noHeader) printHeader();
    console.log(`Deploying commit '${commit}' to '${stage}' stage...`);

    // Create GitHub deployment if repo is configured
    const repo = await cicd.getConfig("repo");
    let ghDeployment: any = null;
    if (repo) {
        ghDeployment = github.createDeployment(repo, commit, stage, `Deploy ${appAlias} to ${stage}`);
        if (ghDeployment) {
            github.updateDeploymentStatus(repo, ghDeployment.id, 'in_progress', `Deploying ${appAlias}`);
        }
    }

    let envResults: EnvResult[] | null = null;
    let apiResults: APIResult | null = null;
    let snsResults: SNSResult | null = null;
    let twilioResult: TwilioDeployResult | null = null;

    try {
        if( processEnv ) {
            envResults = await cicd.processFunctionEnvironmentVars();
        }

        if( processApi ) {
            apiResults = await cicd.processApiGateway(stage,appAlias,commit,apiFilter);
        }

        if( processSns ) {
            snsResults = await cicd.processSNS(stage,appAlias,commit);
        }

        if( processTwilioFlag ) {
            twilioResult = await cicd.processTwilio(stage);
        }
    } catch (err: any) {
        // Update GitHub deployment status to failure
        if (repo && ghDeployment) {
            github.updateDeploymentStatus(repo, ghDeployment.id, 'failure', err.message || 'Deployment failed');
        }
        throw err;
    }

    // ── Print summary ─────────────────────────────────────────────────

    // Environment Variables
    if (envResults && envResults.length > 0) {
        console.log(`\nEnvironment Variables:`);
        for (const r of envResults) {
            const status = r.updated ? `${r.varCount} vars` : 'skipped';
            console.log(`  ${r.name.padEnd(40)} ${status}`);
        }
    }

    // API Functions
    if (apiResults && apiResults.functions.length > 0) {
        console.log(`\nAPI Functions:`);
        for (const r of apiResults.functions) {
            const versionLabel = r.version ? `v${r.version}` : '';
            console.log(`  ${r.name.padEnd(40)} ${r.action.padEnd(10)} ${versionLabel}`);
        }
    }

    // API Deployments
    if (apiResults && apiResults.apis.length > 0) {
        console.log(`\nAPI Deployments:`);
        for (const r of apiResults.apis) {
            console.log(`  ${r.name.padEnd(40)} deployment ${r.deployment.padEnd(10)} stage ${r.stage.padEnd(10)} mapping ${r.mapping}`);
        }
    }

    // SNS Functions
    if (snsResults && snsResults.functions.length > 0) {
        console.log(`\nSNS Functions:`);
        for (const r of snsResults.functions) {
            const versionLabel = r.version ? `v${r.version}` : '';
            console.log(`  ${r.name.padEnd(40)} ${r.action.padEnd(10)} ${versionLabel}`);
        }
    }

    // SNS Subscriptions
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

    // Twilio
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
    console.log(`\nSummary: ${parts.join(', ')}`);

    // Update GitHub deployment status to success
    if (repo && ghDeployment) {
        github.updateDeploymentStatus(repo, ghDeployment.id, 'success', `Deployed ${appAlias} to ${stage}: ${parts.join(', ')}`);
    }

    console.log();
    console.timeEnd("api cicd");
}

main();
