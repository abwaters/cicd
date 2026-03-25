import { FargateRestartResult } from './types';

const cicd = require('./shared/cicd');
const options = require("./shared/options");
const credentials = require('./shared/credentials');
const logger = require('./shared/logger');
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
    if( args.length != 1 ) {
        console.log(`restart <stage>`);
        console.log(`  Options: --no-wait, --verbose`);
        process.exit(0);
    }

    const stage = args[0];
    const computeMode = (await cicd.getConfig("computeMode")) || 'lambda';

    if (computeMode !== 'fargate') {
        console.error(`Error: restart command is only available in fargate mode (current: ${computeMode})`);
        process.exit(1);
    }

    await cicd.setStageConfig(stage);

    console.time("restart");
    if (!o.noHeader) printHeader();

    console.log(`Force restarting '${stage}' stage...`);

    const result: FargateRestartResult = await cicd.processFargateRestart(stage, !!o.noWait);

    console.log(`\nFargate Restart:`);
    console.log(`  Cluster: ${result.cluster}`);
    console.log(`  Service: ${result.service}`);
    console.log(`  Task Definition: ${result.taskDefinitionArn}`);
    if (o.noWait) {
        console.log(`  Service Stable:  skipped (--no-wait)`);
    } else {
        console.log(`  Service Stable:  ${result.serviceStable ? 'yes' : 'no'}`);
        if (!result.serviceStable) {
            console.log(`\n  WARNING: Service did not stabilize within timeout. Check ECS console.`);
        }
    }

    console.log();
    console.timeEnd("restart");
}

main();
