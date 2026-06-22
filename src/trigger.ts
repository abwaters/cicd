import * as cicd from './shared/cicd';
import * as batch from './shared/batch';
import * as options from './shared/options';
import * as credentials from './shared/credentials';
import * as logger from './shared/logger';
import { printHeader } from './shared/header';

// `run <stage> <job>` — submit a Batch job on demand against the latest ACTIVE
// job-definition revision (the same one the EventBridge schedule resolves by
// name). Replaces a manual `aws batch submit-job`. --debug overrides DEBUG=true.
async function main(): Promise<void> {
    await credentials.validateCredentials();

    let args = process.argv.slice(2);
    const o = options.getOptions(args);
    args = options.stripOptions(args);

    if (o.verbose) {
        logger.setVerbose(true);
        logger.log('Verbose mode enabled');
    }

    if (args.length !== 2) {
        console.log(`run <stage> <job>`);
        console.log(`  Options: --debug, --verbose`);
        process.exit(0);
    }

    const stage = args[0];
    const jobName = args[1];

    const computeMode = (await cicd.getConfig("computeMode")) || 'lambda';
    if (computeMode !== 'batch') {
        console.error(`Error: run command is only available in batch mode (current: ${computeMode})`);
        process.exit(1);
    }

    // Validates the stage exists and lets init() resolve stage env / exports.
    await cicd.setStageConfig(stage);

    const app: string = await cicd.getConfig('app');
    const batchConfig = await cicd.resolveBatchConfig();

    const job = batchConfig.jobs.find(j => j.name === jobName);
    if (!job) {
        const available = batchConfig.jobs.map(j => j.name).join(', ');
        console.error(`Error: job '${jobName}' not found in cicd.json batch.jobs (available: ${available})`);
        process.exit(1);
    }

    const jobDefName = cicd.batchJobDefinitionName(app, stage, jobName);

    if (!o.noHeader) printHeader();

    // Confirm a revision is actually deployed before submitting.
    const def = await batch.describeLatestJobDefinition(jobDefName);
    if (!def) {
        console.error(`Error: no ACTIVE job definition '${jobDefName}' — deploy a commit to '${stage}' first.`);
        process.exit(1);
    }

    const debug = !!o.debug;
    const overrides = debug ? { DEBUG: 'true' } : undefined;
    // Submission name must be DNS-ish; timestamp keeps it unique per invocation.
    const submissionName = `${jobDefName}-manual-${Date.now()}`.replace(/[^a-zA-Z0-9_-]/g, '-');

    console.log(`Submitting '${jobDefName}' (rev ${def.revision}) to queue...${debug ? ' [DEBUG]' : ''}`);
    const jobId = await batch.submitJob(batchConfig.jobQueue, jobDefName, submissionName, overrides);

    console.log(`\nBatch Job Submitted:`);
    console.log(`  Job:        ${jobDefName}:${def.revision}`);
    console.log(`  Queue:      ${batchConfig.jobQueue}`);
    console.log(`  Job ID:     ${jobId}`);
    console.log(`  Submission: ${submissionName}`);
    console.log();
}

export { main as run };
