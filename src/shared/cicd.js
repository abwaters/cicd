const lambda = require("./lambda");
const apigw = require("./apigw");
const sns = require("./sns");
const twilio = require("./twilio");
const utils = require('./utils');
const cf = require('./cloudformation');
const ps = require('./ps');
const {getConfig} = require('./config');
const logger = require('./logger');

const EXTENDED_SLEEP_TIME = 2000;

const rawExports = new Map();
const exportMap = new Map();
const functionMap = new Map();
let envCache = null;
const psCache = new Map();
let stageConfig = null;

async function init() {
    if( !exportMap || exportMap.size === 0 ) {
        await initExports();
    }

    if( !envCache ) {
        await initEnvironment();
    }
}

async function getVar(key) {
    await init();
    let val = '';
    if( envCache.has(key) ) {
        val = envCache.get(key);
    }
    if( !val ) {
        console.log(`VARIABLE ${key} is empty.`);
        process.exit(-1);
    }
    return val ;
}

function splitVars(varNames) {
    const names = varNames.split(',');
    return names.map(n=>n.trim());
}

async function getVars(vars) {
    if( typeof vars === 'string' ) {
        vars = splitVars(vars);
    }
    if( !Array.isArray(vars) ) {
        return null;
    }
    const env = {};
    for(const v of vars) {
        env[v] = await getVar(v);
    }
    return env;
}

async function resolveVariable(key) {
    let val = '';
    if( key.startsWith('!ImportValue ') ) {
        const importName = key.substring(13).trim();
        if( rawExports.has(importName) ) {
            val = rawExports.get(importName);
        }else{
            val = '';
        }
    }else if( key.startsWith('!SetEnv ') ) {
        const envName = key.substring(8).trim();
        val = process.env[envName];
        if (val) {
            val = val.replace(/\\"/g, '"');
            val = val.replace(/\\\\n/g, "\\n");
        } else {
            val = '';
        }
    }else if( key.startsWith('!ParameterStore ') ) {
        const psName = key.substring(16).trim();
        if( psCache.has(psName) ) {
            val = psCache.get(psName);
        } else {
            val = await ps.getParameterValue(psName, true);
            if (val) {
                val = val.replace(/\\"/g, '"');
                val = val.replace(/\\\\n/g, "\\n");
            } else {
                val = '';
            }
            psCache.set(psName, val);
        }
    }
    return val;
}

async function initEnvironmentVars(env) {
    if (!env) {
        return;
    }
    const envConfig = Object.keys(env) ;
    for(const key of envConfig) {
        let val = await resolveVariable(env[key]);
        envCache.set(key,val);
    }
}

async function setStageConfig(stage) {
    stageConfig = await getStageConfig(stage);
}

async function initEnvironment() {
    envCache = new Map();

    // process primary variables
    const processVars = await getConfig("environment");
    await initEnvironmentVars(processVars);

    // process stage env vars
    if( stageConfig ) {
        const stageVars = stageConfig.environment;
        await initEnvironmentVars(stageVars);
    }
}

async function initExports() {
    try {
        const exportConfigs = await getConfig('exports');
        for(const cfg of exportConfigs) {
            exportMap.set(cfg.name,cfg);
            if( cfg.functions ) {
                for(const f of cfg.functions) {
                    functionMap.set(f.name,f);
                }
            }
        }

        // get exports and load them
        const response = await cf.listExports();
        for(const e of response) {
            if( exportMap.has(e.Name) ) {
                const cfg = exportMap.get(e.Name);
                cfg.value = e.Value;
            }else if( functionMap.has(e.Name) ) {
                const cfg = functionMap.get(e.Name);
                cfg.value = e.Value;
            }
            rawExports.set(e.Name,e.Value);
        }

        // did we miss any exports in the config?
        let cnt = 0;
        for(const cfg of exportMap.values()) {
            if( !cfg.hasOwnProperty('value') ) {
                console.log(`ERROR: could not find export for '${cfg.name}'.`);
                cnt++;
            }
        }

        for(const cfg of functionMap.values()) {
            if( !cfg.hasOwnProperty('value') ) {
                console.log(`ERROR: could not find export for '${cfg.name}'.`);
                cnt++;
            }
        }
        if( cnt ) {
            process.exit(-1);
        }

        // update values for any items that don't have values
        for(const cfg of exportConfigs) {
            if( !cfg.value ) {
                const entry = exportMap.get(cfg.name);
                cfg.value = entry.value;
            }
            if( cfg.functions ) {
                for(const f of cfg.functions) {
                    if( !f.value ) {
                        const entry = functionMap.get(f.name);
                        f.value = entry.value;
                    }
                }
            }
        }

    }catch(e) {
        console.log(e);
        console.log(`ERROR: couldn't get exports`);
        process.exit(-1);
    }
}

async function getExportByName(name) {
    await init();
    if( exportMap.has(name) ) {
        return exportMap.get(name);
    }
    return null;
}

async function getExportsByType(type,filter) {
    await init();
    if( filter ) {
        const exports = [...exportMap.values()];
        return exports.filter( resource => resource.type === type && resource.name === filter );
    }else{
        const exports = [...exportMap.values()];
        return exports.filter( resource => resource.type === type);
    }
}

async function getLambdaExports(type,filter) {
    await init();
    const entries = await getExportsByType(type,filter);
    const expFunctions = {};
    for(const entry of entries) {
        if( entry.functions ) {
            for(const func of entry.functions) {
                expFunctions[func.name] = func;
            }
        }
    }
    return [...Object.values(expFunctions)];
}

async function findVersion(functionName,commit) {
    await utils.sleep();
    const versions = await lambda.listVersions(functionName);
    for(const version of versions) {
        if( version.description.includes(commit) ) {
            return version.Version;
        }
    }
    return '';
}

async function findAlias(functionName,commit) {
    await utils.sleep();
    const aliases = await lambda.listAliases(functionName);
    for(const alias of aliases) {
        if( alias.alias.includes(commit) ) {
            return alias.alias;
        }
    }
    return '';
}

async function findTag(functionName,commit) {
    const fc = await lambda.describeFunction(functionName);
    const tags = await lambda.listFunctionTags(fc.FunctionArn);
    if( tags.hasOwnProperty('Commit') ) {
        if( tags.Commit.includes(commit) ) {
            return true;
        }
    }
    return false;
}

async function findDeployment(apiId,commit) {
    await utils.sleep();
    const deployments = await apigw.listDeployments(apiId);
    for(const deployment of deployments) {
        if( deployment.description && deployment.description.includes(commit) ) {
            return deployment;
        }
    }
    return null;
}

async function findStages(apiId,stage) {
    await utils.sleep();
    const stages = await apigw.listStages(apiId);
    for(const s of stages) {
        if( s.stageName === stage ) {
            return s;
        }
    }
    return null;
}

async function findMapping(domain,apiId,stage) {
    await utils.sleep();
    const mappings = await apigw.listBasePathMappings(domain);
    for(const m of mappings) {
        if( m.restApiId === apiId && m.stage === stage ) {
            return m;
        }
    }
    return null;
}

async function getStageConfig(stage) {
    const stageConfigs = await getConfig("stages");
    let stageConfig = null;
    for(const sc of stageConfigs) {
        if( sc.stage === stage ) {
            stageConfig = sc;
            break;
        }
    }

    if( !stageConfig ) {
        console.log(`No configuration for ${stage}`);
        process.exit(-1);
    }
    return stageConfig;
}

async function processFunctionEnvironmentVars() {
    const apiFunctions =  await getLambdaExports('api');
    const snsFunctions =  await getLambdaExports('sns');
    const functions = [...apiFunctions,...snsFunctions];
    const results = [];
    logger.verbose(`\n * Creating environment vars for functions:`);
    for(const f of functions) {
        const functionName = f.value;
        const funcEnv = await getVars(f.env);
        if( funcEnv ) {
            logger.verbose(`   - setting environment vars for function: '${functionName}'...`);
            await lambda.updateEnvironmentVariables(functionName,funcEnv);
            results.push({ name: functionName, updated: true, varCount: Object.keys(funcEnv).length });
        } else {
            logger.verbose(`     x no vars for '${functionName}'`);
            results.push({ name: functionName, updated: false, varCount: 0 });
        }
    }
    await utils.sleep(EXTENDED_SLEEP_TIME);
    return results;
}

async function processApiGatewayFunctions(stage,appAlias,commit,apiFilter)
{
    const stageConfig = await getStageConfig(stage);
    const functions =  await getLambdaExports('api',apiFilter);
    const results = [];
    logger.verbose(`\n * Creating versions and aliases for functions:`);
    for(const f of functions) {
        logger.verbose(` * Checking function '${f.value}'...`);
        const functionName = f.value;
        let version = await findVersion(functionName,commit);
        let alias = await findAlias(functionName,appAlias);
        if( alias ) {
            logger.verbose(`   - alias for commit '${commit}' exists for function '${functionName}'`);
            if( f.concurrency ) {
                const r = await lambda.updateProvisionedConcurrency(functionName,appAlias,Number(f.concurrency));
                logger.verbose(`   - updating '${functionName}:${appAlias}' concurrency to ${f.concurrency}`);
            }
            results.push({ name: functionName, action: 'exists', version });
        }else{
            if( !version ) {
                await utils.sleep();
                let v = await lambda.publishNewVersion(functionName,appAlias);
                version = v.version;
                logger.verbose(`   - using version ${version} for '${commit}'`);
                let arn = v.arn.substring(0, v.arn.lastIndexOf(':')) ;
                await utils.sleep();
                let tags = await lambda.listFunctionTags(arn);
                if( tags.Commit !== commit ) {
                    logger.verbose(`   - creating alias '${appAlias}' for earlier version of function at commit '${tags.Commit}'`);
                }
            }
            await utils.sleep();
            const r = await lambda.createAlias(functionName,appAlias,version);
            logger.verbose(`   - alias '${appAlias}' for commit '${commit}' created for function '${functionName}'`);
            if( f.concurrency ) {
                const r = await lambda.updateProvisionedConcurrency(functionName,appAlias,Number(f.concurrency));
                logger.verbose(`   - updating '${functionName}:${appAlias}' concurrency to ${f.concurrency}`);
            }
            results.push({ name: functionName, action: 'created', version });
        }
    }
    return results;
}

async function processApiGatewayApis(stage,appAlias,commit,apiFilter){
    const account = await getConfig("account");
    const region = await getConfig("region");
    const globalThrottle = await getConfig("throttle");
    const stageConfig = await getStageConfig(stage);
    const apis = await getExportsByType('api',apiFilter);
    const results = [];
    logger.verbose(`\n * Updating apis to deploy stage and ensure custom domain mappings:`);
    for(const api of apis) {
        const apiId = api.value;
        logger.verbose(` * Checking api ${api.name} [${api.value}]...`);
        let deploymentAction = 'existing';
        let deployment = await findDeployment(apiId,commit);
        if( !deployment ) {
            await utils.sleep();
            deployment = await apigw.createDeployment(apiId,commit);
            logger.verbose(`   - created deployment '${deployment.id}'`);
            deploymentAction = 'created';
        }else{
            logger.verbose(`   - using deployment '${deployment.id}'`);
        }

        // Resolve throttle settings: API-level > stage-level > global defaults
        let throttleSettings = null;
        let throttleSource = null;
        if (api.throttle) {
            throttleSettings = api.throttle;
            throttleSource = 'API-specific';
        } else if (stageConfig.throttle) {
            throttleSettings = stageConfig.throttle;
            throttleSource = 'stage-level';
        } else if (globalThrottle) {
            throttleSettings = globalThrottle;
            throttleSource = 'global';
        }

        // Validate throttle settings before using them
        let throttleLabel = 'none';
        if (throttleSettings &&
            throttleSettings.rateLimit !== undefined &&
            throttleSettings.burstLimit !== undefined) {
            logger.verbose(`   - using ${throttleSource} throttle: ${throttleSettings.rateLimit} req/s, ${throttleSettings.burstLimit} burst`);
            throttleLabel = `${throttleSource} (${throttleSettings.rateLimit}/${throttleSettings.burstLimit})`;
        } else {
            logger.verbose(`   - no throttle settings configured (using AWS defaults)`);
            throttleSettings = null;  // Ensure we don't pass partial config to AWS
        }

        let stageAction = 'updated';
        const currentStage = await findStages(apiId,stage);
        if( currentStage ) {
            logger.verbose(`   - updating existing stage '${stage}' to '${deployment.id}' for '${appAlias}'`);
            await utils.sleep();
            await apigw.updateStage(apiId,stage,deployment.id,appAlias,throttleSettings);
        }else{
            logger.verbose(`   - creating stage '${stage}' to '${deployment.id}' for '${appAlias}'`);
            await utils.sleep();
            await apigw.createStage(apiId,stage,deployment.id,appAlias,throttleSettings);
            stageAction = 'created';
        }

        let path = api.path;
        if( stageConfig.mapping.path ) {
            path = stageConfig.mapping.path + "/" + path;
        }
        let mappingAction = 'existing';
        const m = await findMapping(stageConfig.mapping.domain,apiId,stage);
        if( m ) {
            logger.verbose(`   - using existing mapping for ${stageConfig.mapping.domain} with path '${path}'`);
        }else{
            logger.verbose(`   - create mapping for ${stageConfig.mapping.domain} with path '${path}'`);
            try {
                await utils.sleep();
                await apigw.createCustomDomainMappingV2(stageConfig.mapping.domain,apiId,stage,path);
                mappingAction = 'created';
            }catch(e) {
                logger.verbose(`   x mapping for ${stageConfig.mapping.domain} with path '${path}' already exists`);
            }
        }

        // arn:aws:lambda:us-west-2:XXXXXXXXXXXXX:function:GetHelloWithName
        // update permissions for functions
        for(const f of api.functions) {
            logger.verbose(`   - updating permissions for '${f.name}'`);
            const functionName = f.value;
            let functionArn = `arn:aws:lambda:${region}:${account}:function:${functionName}:${appAlias}`;
            let sourceArn = `arn:aws:execute-api:${region}:${account}:${apiId}/*/${f.method}/*`;
            await utils.sleep();
            await lambda.addFunctionPermission(functionArn, sourceArn,'apigateway.amazonaws.com');
        }

        results.push({
            name: api.name,
            deployment: deploymentAction,
            stage: stageAction,
            mapping: mappingAction,
            throttle: throttleLabel,
            functions: api.functions.length
        });
    }
    return results;
}

async function processApiGateway(stage,appAlias,commit,apiFilter) {
    const functions = await processApiGatewayFunctions(stage,appAlias,commit,apiFilter);
    const apis = await processApiGatewayApis(stage,appAlias,commit,apiFilter);
    return { functions, apis };
}

async function processSNSFunctions(stage,appAlias,commit) {
    const functions =  await getLambdaExports('sns');
    const results = [];
    logger.verbose(`\nCreating versions and aliases for functions:`);
    for(const f of functions) {
        logger.verbose(` * Checking function '${f.value}'...`);
        const functionName = f.value;
        let version = await findVersion(functionName,commit);
        let alias = await findAlias(functionName,appAlias);
        if( alias ) {
            logger.verbose(`   - alias for commit '${commit}' exists for function '${functionName}'`);
            results.push({ name: functionName, action: 'exists', version });
        }else if( !alias ) {
            if( !version ) {
                await utils.sleep();
                let v = await lambda.publishNewVersion(functionName,appAlias);
                version = v.version;
                logger.verbose(`   - using version ${version} for '${commit}'`);
                let arn = v.arn.substring(0, v.arn.lastIndexOf(':')) ;
                await utils.sleep();
                let tags = await lambda.listFunctionTags(arn);
                if( tags.Commit !== commit ) {
                    logger.verbose(`   - creating alias '${appAlias}' for earlier version of function at commit '${tags.Commit}'`);
                }
            }
            await utils.sleep();
            const r = await lambda.createAlias(functionName,appAlias,version);
            logger.verbose(`   - alias '${appAlias}' for commit '${commit}' created for function '${functionName}'`);
            results.push({ name: functionName, action: 'created', version });
        }
    }
    return results;
}

async function processSNSSubscriptions(stage,appAlias,commit) {
    const account = await getConfig("account");
    const region = await getConfig("region");
    const topics = await getExportsByType('sns');
    const results = [];
    logger.verbose(`\n * Updating SNS subscriptions:`);
    for(const topic of topics) {

        // checking sns for stage
        if( topic.hasOwnProperty('stages') ) {
            if( !topic.stages.includes(stageConfig.stage) ) {
                logger.verbose(`   - skipping '${topic.name}' in '${stageConfig.stage}'`);
                results.push({ name: topic.name, action: 'skipped' });
                continue;
            }
        }

        let oldRemoved = 0;
        for(const f of topic.functions) {
            logger.verbose(`   - updating permissions for '${f.name}'`);
            const functionName = f.value;
            let functionArn = `arn:aws:lambda:${region}:${account}:function:${functionName}:${appAlias}`;
            await utils.sleep(EXTENDED_SLEEP_TIME);
            await lambda.addFunctionPermission(functionArn, topic.value,'sns.amazonaws.com');

            // cleaning up existing subscriptions
            const subscriptions = await sns.listSubscriptionsByTopic(topic.value);
            for(const subscription of subscriptions) {
                const parts = subscription.endpoint.split(':');
                if( parts.length === 8 && parts[7] !== appAlias ) {
                    logger.verbose(`   - deleting old subscription to SNS topic '${topic.name}'`);
                    await sns.deleteSubscription(subscription.subscriptionArn);
                    oldRemoved++;
                }
            }

            logger.verbose(`   - subscribing lambda to SNS topic '${topic.name}'`);
            await sns.subscribeLambdaToTopic(topic.value,functionArn);
        }
        results.push({ name: topic.name, action: 'subscribed', oldRemoved });
    }
    return results;
}

async function processSNS(stage,appAlias,commit) {
    const topics = await getExportsByType('sns');
    if (topics.length === 0) {
        return null;
    }
    logger.verbose(`\nUpdating sns topics:`);
    const functions = await processSNSFunctions(stage,appAlias,commit);
    const subscriptions = await processSNSSubscriptions(stage,appAlias,commit);
    return { functions, subscriptions };
}

async function processTwilio(stage) {
    if (!stageConfig || !stageConfig.twilio) {
        return null;
    }

    const twilioConfig = stageConfig.twilio;

    // Read Twilio credentials from process environment (independent of Lambda env vars)
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    if (!accountSid || !authToken) {
        logger.verbose(`   - Twilio credentials not found in environment, skipping`);
        return null;
    }

    // Look up the API export to get its path
    const apiExport = exportMap.get(twilioConfig.smsWebhookApi);
    if (!apiExport) {
        logger.verbose(`   - Twilio smsWebhookApi '${twilioConfig.smsWebhookApi}' not found in exports, skipping`);
        return null;
    }

    // Build webhook URL: https://{domain}/{mapping.path}/{api.path}
    const segments = [stageConfig.mapping.domain];
    if (stageConfig.mapping.path) {
        segments.push(stageConfig.mapping.path);
    }
    segments.push(apiExport.path);
    const webhookUrl = 'https://' + segments.join('/');

    let sid = twilioConfig.messagingSid;
    if (sid.startsWith('!')) {
        sid = await resolveVariable(sid);
        if (!sid) {
            logger.verbose(`   - Could not resolve Twilio messagingSid, skipping`);
            return null;
        }
    }
    const isMessagingService = twilio.isMessagingServiceSid(sid);

    if (isMessagingService) {
        logger.verbose(`\n * Updating Twilio messaging service webhook:`);
        logger.verbose(`   - messaging service SID: ${sid}`);
        logger.verbose(`   - webhook URL: ${webhookUrl}`);

        const result = await twilio.updateMessagingServiceWebhook(
            accountSid, authToken, sid, webhookUrl
        );

        logger.verbose(`   - updated ${result.friendlyName} → ${result.inboundRequestUrl}`);

        return {
            messagingSid: sid,
            friendlyName: result.friendlyName,
            webhookUrl: result.inboundRequestUrl,
            action: 'updated'
        };
    } else {
        logger.verbose(`\n * Updating Twilio phone number webhook:`);
        logger.verbose(`   - phone number SID: ${sid}`);
        logger.verbose(`   - webhook URL: ${webhookUrl}`);

        const result = await twilio.updatePhoneNumberWebhook(
            accountSid, authToken, sid, webhookUrl
        );

        logger.verbose(`   - updated ${result.phoneNumber} → ${result.smsUrl}`);

        return {
            messagingSid: sid,
            phoneNumber: result.phoneNumber,
            webhookUrl: result.smsUrl,
            action: 'updated'
        };
    }
}

module.exports = {
    getLambdaExports,
    getExportsByType,
    getConfig,
    getVar,
    processFunctionEnvironmentVars,
    processApiGateway,
    processSNS,
    processTwilio,
    resolveVariable,
    setStageConfig}