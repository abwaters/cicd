const cicd = require('./shared/cicd');
const options = require("./shared/options");
const credentials = require('./shared/credentials');
const logger = require('./shared/logger');
const { printHeader } = require('./shared/header');

const SLEEP_TIME = 2000;

async function main() {
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
    let processApi = true;
    let processSns = true ;
    if( o.env ) {
        processEnv = true;
        processApi = false;
        processSns = false;
    }else if( o.api || o.sns ) {
        processApi = processSns = false;
        processApi = o.api;
        processSns = o.sns;
    }

    if( processApi || processSns ) {
        processEnv = true;
    }

    let apiFilter = '';
    if( o.apiFilter ) {
        apiFilter = o.apiFilter ;
    }

    // TODO: formalize the cicd initialization...
    const stage = args[0];
    const commit = args[1];
    const app = await cicd.getConfig("app");
    const appAlias = `${app}-${commit}`;
    await cicd.setStageConfig(stage);

    console.time("api cicd");
    if (!o.noHeader) printHeader();
    console.log(`Preparing to deploy commit '${commit}' to '${stage}' stage.`);

    if( processEnv ) {
        await cicd.processFunctionEnvironmentVars();
    }

    if( processApi ) {
        await cicd.processApiGateway(stage,appAlias,commit,apiFilter);
    }

    if( processSns ) {
        await cicd.processSNS(stage,appAlias,commit);
    }

    console.log();
    console.timeEnd("api cicd");
}

main();