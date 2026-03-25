import {
    ExportConfig,
    FunctionConfig,
    FargateConfig,
    FargateDeployResult,
    FargateRestartResult,
    StageConfig,
    ThrottleSettings,
    EnvResult,
    APIFunctionResult,
    APIDeploymentResult,
    APIResult,
    SNSFunctionResult,
    SNSSubscriptionResult,
    SNSResult,
    TwilioDeployResult,
    VersionInfo
} from '../types';
import { Deployment, Stage, BasePathMapping } from '@aws-sdk/client-api-gateway';
import { ContainerDefinition } from '@aws-sdk/client-ecs';

const lambda = require("./lambda");
const apigw = require("./apigw");
const sns = require("./sns");
const twilio = require("./twilio");
const ecs = require("./ecs");
const cf = require('./cloudformation');
const ps = require('./ps');
const {getConfig} = require('./config');
const logger = require('./logger');

const rawExports = new Map<string, string>();
const exportMap = new Map<string, ExportConfig>();
const functionMap = new Map<string, FunctionConfig>();
let envCache: Map<string, string> | null = null;
const psCache = new Map<string, string>();
let stageConfig: StageConfig | null = null;
let exportsInitialized = false;

async function init(): Promise<void> {
    if( !exportsInitialized ) {
        await initExports();
        exportsInitialized = true;
    }

    if( !envCache ) {
        await initEnvironment();
    }
}

async function getVar(key: string): Promise<string> {
    await init();
    let val = '';
    if( envCache!.has(key) ) {
        val = envCache!.get(key)!;
    }
    if( !val ) {
        console.log(`VARIABLE ${key} is empty.`);
        process.exit(-1);
    }
    return val ;
}

function splitVars(varNames: string): string[] {
    const names = varNames.split(',');
    return names.map(n=>n.trim());
}

async function getVars(vars: string | string[] | undefined): Promise<Record<string, string> | null> {
    if( typeof vars === 'string' ) {
        vars = splitVars(vars);
    }
    if( !Array.isArray(vars) ) {
        return null;
    }
    const env: Record<string, string> = {};
    for(const v of vars) {
        env[v] = await getVar(v);
    }
    return env;
}

async function resolveVariable(key: string): Promise<string> {
    let val = '';
    if( key.startsWith('!ImportValue ') ) {
        const importName = key.substring(13).trim();
        if( rawExports.has(importName) ) {
            val = rawExports.get(importName)!;
        }else{
            val = '';
        }
    }else if( key.startsWith('!SetEnv ') ) {
        const envName = key.substring(8).trim();
        val = process.env[envName] || '';
        if (val) {
            val = val.replace(/\\"/g, '"');
            val = val.replace(/\\\\n/g, "\\n");
        }
    }else if( key.startsWith('!ParameterStore ') ) {
        const psName = key.substring(16).trim();
        if( psCache.has(psName) ) {
            val = psCache.get(psName)!;
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
    } else {
        val = key;
    }
    return val;
}

async function initEnvironmentVars(env: Record<string, string> | undefined): Promise<void> {
    if (!env) {
        return;
    }
    const envConfig = Object.keys(env) ;
    for(const key of envConfig) {
        let val = await resolveVariable(env[key]);
        envCache!.set(key,val);
    }
}

async function setStageConfig(stage: string): Promise<void> {
    stageConfig = await getStageConfig(stage);
}

async function initEnvironment(): Promise<void> {
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

async function initExports(): Promise<void> {
    try {
        const exportConfigs: ExportConfig[] = (await getConfig('exports')) || [];
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
                const cfg = exportMap.get(e.Name)!;
                cfg.value = e.Value;
            }else if( functionMap.has(e.Name) ) {
                const cfg = functionMap.get(e.Name)!;
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
                const entry = exportMap.get(cfg.name)!;
                cfg.value = entry.value;
            }
            if( cfg.functions ) {
                for(const f of cfg.functions) {
                    if( !f.value ) {
                        const entry = functionMap.get(f.name)!;
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

async function getExportByName(name: string): Promise<ExportConfig | null> {
    await init();
    if( exportMap.has(name) ) {
        return exportMap.get(name)!;
    }
    return null;
}

async function getExportsByType(type: string, filter?: string): Promise<ExportConfig[]> {
    await init();
    if( filter ) {
        const exports = [...exportMap.values()];
        return exports.filter( resource => resource.type === type && resource.name === filter );
    }else{
        const exports = [...exportMap.values()];
        return exports.filter( resource => resource.type === type);
    }
}

async function getLambdaExports(type: string, filter?: string): Promise<FunctionConfig[]> {
    await init();
    const entries = await getExportsByType(type,filter);
    const expFunctions: Record<string, FunctionConfig> = {};
    for(const entry of entries) {
        if( entry.functions ) {
            for(const func of entry.functions) {
                expFunctions[func.name] = func;
            }
        }
    }
    return [...Object.values(expFunctions)];
}

async function findVersion(functionName: string, commit: string): Promise<string> {
    const versions = await lambda.listVersions(functionName);
    for(const version of versions) {
        if( version.description.includes(commit) ) {
            return version.version;
        }
    }
    return '';
}

async function findAlias(functionName: string, commit: string): Promise<string> {
    const aliases = await lambda.listAliases(functionName);
    for(const alias of aliases) {
        if( alias.alias.includes(commit) ) {
            return alias.alias;
        }
    }
    return '';
}

async function findTag(functionName: string, commit: string): Promise<boolean> {
    const fc = await lambda.describeFunction(functionName);
    const tags = await lambda.listFunctionTags(fc.FunctionArn);
    if( tags.hasOwnProperty('Commit') ) {
        if( tags.Commit.includes(commit) ) {
            return true;
        }
    }
    return false;
}

async function findDeployment(apiId: string, commit: string): Promise<Deployment | null> {
    const deployments = await apigw.listDeployments(apiId);
    for(const deployment of deployments) {
        if( deployment.description && deployment.description.includes(commit) ) {
            return deployment;
        }
    }
    return null;
}

async function findStages(apiId: string, stage: string): Promise<Stage | null> {
    const stages = await apigw.listStages(apiId);
    for(const s of stages) {
        if( s.stageName === stage ) {
            return s;
        }
    }
    return null;
}

async function findMapping(domain: string, apiId: string, stage: string): Promise<BasePathMapping | null> {
    const mappings = await apigw.listBasePathMappings(domain);
    for(const m of mappings) {
        if( m.restApiId === apiId && m.stage === stage ) {
            return m;
        }
    }
    return null;
}

async function getStageConfig(stage: string): Promise<StageConfig> {
    const stageConfigs: StageConfig[] = await getConfig("stages");
    let foundConfig: StageConfig | null = null;
    for(const sc of stageConfigs) {
        if( sc.stage === stage ) {
            foundConfig = sc;
            break;
        }
    }

    if( !foundConfig ) {
        console.log(`No configuration for ${stage}`);
        process.exit(-1);
    }
    return foundConfig!;
}

async function processFunctionEnvironmentVars(): Promise<EnvResult[]> {
    const apiFunctions =  await getLambdaExports('api');
    const snsFunctions =  await getLambdaExports('sns');
    const functions = [...apiFunctions,...snsFunctions];
    const results: EnvResult[] = [];
    logger.verbose(`\n * Creating environment vars for functions:`);
    for(const f of functions) {
        const functionName = f.value!;
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
    return results;
}

async function processApiGatewayFunctions(stage: string, appAlias: string, commit: string, apiFilter?: string): Promise<APIFunctionResult[]> {
    const localStageConfig = await getStageConfig(stage);
    const functions =  await getLambdaExports('api',apiFilter);
    const results: APIFunctionResult[] = [];
    logger.verbose(`\n * Creating versions and aliases for functions:`);
    for(const f of functions) {
        logger.verbose(` * Checking function '${f.value}'...`);
        const functionName = f.value!;
        let version = await findVersion(functionName,commit);
        let alias = await findAlias(functionName,appAlias);
        if( alias ) {
            logger.verbose(`   - alias for commit '${commit}' exists for function '${functionName}'`);
            if( f.concurrency ) {
                await lambda.updateProvisionedConcurrency(functionName,appAlias,Number(f.concurrency));
                logger.verbose(`   - updating '${functionName}:${appAlias}' concurrency to ${f.concurrency}`);
            }
            results.push({ name: functionName, action: 'exists', version });
        }else{
            if( !version ) {
                let v: VersionInfo = await lambda.publishNewVersion(functionName,appAlias);
                version = v.version;
                logger.verbose(`   - using version ${version} for '${commit}'`);
                let arn = v.arn.substring(0, v.arn.lastIndexOf(':')) ;
                let tags = await lambda.listFunctionTags(arn);
                if( tags.Commit !== commit ) {
                    logger.verbose(`   - creating alias '${appAlias}' for earlier version of function at commit '${tags.Commit}'`);
                }
            }
            await lambda.createAlias(functionName,appAlias,version);
            logger.verbose(`   - alias '${appAlias}' for commit '${commit}' created for function '${functionName}'`);
            if( f.concurrency ) {
                await lambda.updateProvisionedConcurrency(functionName,appAlias,Number(f.concurrency));
                logger.verbose(`   - updating '${functionName}:${appAlias}' concurrency to ${f.concurrency}`);
            }
            results.push({ name: functionName, action: 'created', version });
        }
    }
    return results;
}

async function processApiGatewayApis(stage: string, appAlias: string, commit: string, apiFilter?: string): Promise<APIDeploymentResult[]> {
    const account = await getConfig("account");
    const region = await getConfig("region");
    const globalThrottle: ThrottleSettings | undefined = await getConfig("throttle");
    const localStageConfig = await getStageConfig(stage);
    const apis = await getExportsByType('api',apiFilter);
    const results: APIDeploymentResult[] = [];
    logger.verbose(`\n * Updating apis to deploy stage and ensure custom domain mappings:`);
    for(const api of apis) {
        const apiId = api.value!;
        logger.verbose(` * Checking api ${api.name} [${api.value}]...`);
        let deploymentAction: 'created' | 'existing' = 'existing';
        let deployment = await findDeployment(apiId,commit);
        if( !deployment ) {
            deployment = await apigw.createDeployment(apiId,commit);
            logger.verbose(`   - created deployment '${deployment!.id}'`);
            deploymentAction = 'created';
        }else{
            logger.verbose(`   - using deployment '${deployment.id}'`);
        }

        // Resolve throttle settings: API-level > stage-level > global defaults
        let throttleSettings: ThrottleSettings | null = null;
        let throttleSource: string | null = null;
        if (api.throttle) {
            throttleSettings = api.throttle;
            throttleSource = 'API-specific';
        } else if (localStageConfig.throttle) {
            throttleSettings = localStageConfig.throttle;
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

        let stageAction: 'created' | 'updated' = 'updated';
        const currentStage = await findStages(apiId,stage);
        if( currentStage ) {
            logger.verbose(`   - updating existing stage '${stage}' to '${deployment!.id}' for '${appAlias}'`);
            await apigw.updateStage(apiId,stage,deployment!.id,appAlias,throttleSettings);
        }else{
            logger.verbose(`   - creating stage '${stage}' to '${deployment!.id}' for '${appAlias}'`);
            await apigw.createStage(apiId,stage,deployment!.id,appAlias,throttleSettings);
            stageAction = 'created';
        }

        let path = api.path;
        if( localStageConfig.mapping.path ) {
            path = localStageConfig.mapping.path + "/" + path;
        }
        let mappingAction: 'created' | 'existing' = 'existing';
        const m = await findMapping(localStageConfig.mapping.domain,apiId,stage);
        if( m ) {
            logger.verbose(`   - using existing mapping for ${localStageConfig.mapping.domain} with path '${path}'`);
        }else{
            logger.verbose(`   - create mapping for ${localStageConfig.mapping.domain} with path '${path}'`);
            try {
                await apigw.createCustomDomainMappingV2(localStageConfig.mapping.domain,apiId,stage,path);
                mappingAction = 'created';
            }catch(e) {
                logger.verbose(`   x mapping for ${localStageConfig.mapping.domain} with path '${path}' already exists`);
            }
        }

        // update permissions for functions
        for(const f of api.functions) {
            logger.verbose(`   - updating permissions for '${f.name}'`);
            const functionName = f.value!;
            let functionArn = `arn:aws:lambda:${region}:${account}:function:${functionName}:${appAlias}`;
            let sourceArn = `arn:aws:execute-api:${region}:${account}:${apiId}/*/${f.method}/*`;
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

async function processApiGateway(stage: string, appAlias: string, commit: string, apiFilter?: string): Promise<APIResult> {
    const functions = await processApiGatewayFunctions(stage,appAlias,commit,apiFilter);
    const apis = await processApiGatewayApis(stage,appAlias,commit,apiFilter);
    return { functions, apis };
}

async function processSNSFunctions(stage: string, appAlias: string, commit: string): Promise<SNSFunctionResult[]> {
    const functions =  await getLambdaExports('sns');
    const results: SNSFunctionResult[] = [];
    logger.verbose(`\nCreating versions and aliases for functions:`);
    for(const f of functions) {
        logger.verbose(` * Checking function '${f.value}'...`);
        const functionName = f.value!;
        let version = await findVersion(functionName,commit);
        let alias = await findAlias(functionName,appAlias);
        if( alias ) {
            logger.verbose(`   - alias for commit '${commit}' exists for function '${functionName}'`);
            results.push({ name: functionName, action: 'exists', version });
        }else if( !alias ) {
            if( !version ) {
                let v: VersionInfo = await lambda.publishNewVersion(functionName,appAlias);
                version = v.version;
                logger.verbose(`   - using version ${version} for '${commit}'`);
                let arn = v.arn.substring(0, v.arn.lastIndexOf(':')) ;
                let tags = await lambda.listFunctionTags(arn);
                if( tags.Commit !== commit ) {
                    logger.verbose(`   - creating alias '${appAlias}' for earlier version of function at commit '${tags.Commit}'`);
                }
            }
            await lambda.createAlias(functionName,appAlias,version);
            logger.verbose(`   - alias '${appAlias}' for commit '${commit}' created for function '${functionName}'`);
            results.push({ name: functionName, action: 'created', version });
        }
    }
    return results;
}

async function processSNSSubscriptions(stage: string, appAlias: string, commit: string): Promise<SNSSubscriptionResult[]> {
    const account = await getConfig("account");
    const region = await getConfig("region");
    const topics = await getExportsByType('sns');
    const results: SNSSubscriptionResult[] = [];
    logger.verbose(`\n * Updating SNS subscriptions:`);
    for(const topic of topics) {

        // checking sns for stage
        if( topic.hasOwnProperty('stages') ) {
            if( !topic.stages!.includes(stageConfig!.stage) ) {
                logger.verbose(`   - skipping '${topic.name}' in '${stageConfig!.stage}'`);
                results.push({ name: topic.name, action: 'skipped' });
                continue;
            }
        }

        let oldRemoved = 0;
        for(const f of topic.functions) {
            logger.verbose(`   - updating permissions for '${f.name}'`);
            const functionName = f.value!;
            let functionArn = `arn:aws:lambda:${region}:${account}:function:${functionName}:${appAlias}`;
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

async function processSNS(stage: string, appAlias: string, commit: string): Promise<SNSResult | null> {
    const topics = await getExportsByType('sns');
    if (topics.length === 0) {
        return null;
    }
    logger.verbose(`\nUpdating sns topics:`);
    const functions = await processSNSFunctions(stage,appAlias,commit);
    const subscriptions = await processSNSSubscriptions(stage,appAlias,commit);
    return { functions, subscriptions };
}

async function processTwilio(stage: string): Promise<TwilioDeployResult | null> {
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
    const segments: string[] = [stageConfig.mapping.domain];
    if (stageConfig.mapping.path) {
        segments.push(stageConfig.mapping.path);
    }
    segments.push(apiExport.path!);
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
            action: 'updated' as const
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
            action: 'updated' as const
        };
    }
}

async function resolveFargateConfig(): Promise<{ cluster: string; ecrRepository: string; containerName: string; httpApi?: string }> {
    const fargate: FargateConfig = await getConfig('fargate');
    if (!fargate) {
        throw new Error("'fargate' configuration is required when computeMode is 'fargate'");
    }
    const cluster = (await resolveVariable(fargate.cluster)) || fargate.cluster;
    const ecrRepository = (await resolveVariable(fargate.ecrRepository)) || fargate.ecrRepository;
    let httpApi: string | undefined;
    if (fargate.httpApi) {
        httpApi = (await resolveVariable(fargate.httpApi)) || fargate.httpApi;
    }
    return {
        cluster,
        ecrRepository,
        containerName: fargate.containerName,
        httpApi
    };
}

async function processFargateDeploy(stage: string, commit: string): Promise<FargateDeployResult> {
    await init();

    const fargateConfig = await resolveFargateConfig();
    const localStageConfig = await getStageConfig(stage);

    if (!localStageConfig.service || !localStageConfig.taskFamily) {
        throw new Error(`Stage '${stage}' is missing required 'service' or 'taskFamily' for fargate mode`);
    }

    const image = `${fargateConfig.ecrRepository}:${commit}`;
    logger.verbose(`\n * Fargate deploy to service '${localStageConfig.service}':`);
    logger.verbose(`   - image: ${image}`);

    // 1. Get current service state
    const serviceInfo = await ecs.describeService(fargateConfig.cluster, localStageConfig.service);
    logger.verbose(`   - current task definition: ${serviceInfo.taskDefinitionArn}`);

    // 2. Get current task definition for copying
    const currentTaskDef = await ecs.describeTaskDefinition(serviceInfo.taskDefinitionArn);

    // 3. Build merged environment variables
    const resolvedEnvVars: Record<string, string> = {};
    if (envCache) {
        for (const [key, val] of envCache) {
            resolvedEnvVars[key] = val;
        }
    }
    resolvedEnvVars['COMMIT'] = commit;

    // 4. Build new container definitions
    const newContainerDefs: ContainerDefinition[] = (currentTaskDef.containerDefinitions || []).map((cd: ContainerDefinition) => {
        if (cd.name === fargateConfig.containerName) {
            // Start with existing env vars from task def (CF-sourced)
            const existingEnv: Record<string, string> = {};
            for (const e of (cd.environment || [])) {
                if (e.name && e.value !== undefined) {
                    existingEnv[e.name] = e.value;
                }
            }

            // Merge CICD env vars on top
            const mergedEnv = { ...existingEnv, ...resolvedEnvVars };
            const envArray = Object.entries(mergedEnv).map(([name, value]) => ({ name, value }));

            return { ...cd, image, environment: envArray };
        }
        return cd;
    });

    // 5. Register new task definition revision (use stage's taskFamily)
    const taskDefWithFamily = {
        ...currentTaskDef,
        family: localStageConfig.taskFamily
    };
    const newTaskDefArn = await ecs.registerTaskDefinition(taskDefWithFamily, newContainerDefs);
    logger.verbose(`   - registered new task definition: ${newTaskDefArn}`);

    // 6. Update service
    await ecs.updateService(fargateConfig.cluster, localStageConfig.service, newTaskDefArn);
    logger.verbose(`   - service updated to new task definition`);

    // 7. Wait for stability
    logger.verbose(`   - waiting for service stability...`);
    const stable = await ecs.waitForServicesStable(fargateConfig.cluster, localStageConfig.service);
    if (stable) {
        logger.verbose(`   - service is stable`);
    } else {
        logger.verbose(`   - WARNING: service did not stabilize within timeout`);
    }

    // 8. Ensure HTTP API custom domain mapping
    if (fargateConfig.httpApi && localStageConfig.mapping) {
        const domain = localStageConfig.mapping.domain;
        const path = localStageConfig.mapping.path;
        logger.verbose(`\n * Checking HTTP API mapping for ${domain} with path '${path}':`);

        const existingMappings = await apigw.listApiMappingsV2(domain);
        const existing = existingMappings.find((m: any) =>
            m.ApiId === fargateConfig.httpApi && (m.ApiMappingKey || '') === (path || '')
        );

        if (existing) {
            logger.verbose(`   - mapping already exists for ${domain}/${path}`);
        } else {
            logger.verbose(`   - creating mapping for ${domain} with path '${path}'`);
            try {
                await apigw.createCustomDomainMappingV2(domain, fargateConfig.httpApi, '$default', path);
                logger.verbose(`   - mapping created`);
            } catch (e: any) {
                logger.verbose(`   x mapping creation failed: ${e.message}`);
            }
        }
    }

    return {
        taskDefinitionArn: newTaskDefArn,
        previousTaskDefinitionArn: serviceInfo.taskDefinitionArn,
        image,
        serviceStable: stable
    };
}

async function processFargateRestart(stage: string, noWait: boolean = false): Promise<FargateRestartResult> {
    await init();

    const fargateConfig = await resolveFargateConfig();
    const localStageConfig = await getStageConfig(stage);

    if (!localStageConfig.service) {
        throw new Error(`Stage '${stage}' is missing required 'service' for fargate mode`);
    }

    logger.verbose(`\n * Fargate restart for service '${localStageConfig.service}':`);

    // 1. Get current service state
    const serviceInfo = await ecs.describeService(fargateConfig.cluster, localStageConfig.service);
    logger.verbose(`   - current task definition: ${serviceInfo.taskDefinitionArn}`);

    // 2. Force new deployment
    await ecs.forceUpdateService(fargateConfig.cluster, localStageConfig.service);
    logger.verbose(`   - force new deployment triggered`);

    // 3. Wait for stability (unless --no-wait)
    let stable = true;
    if (!noWait) {
        logger.verbose(`   - waiting for service stability...`);
        stable = await ecs.waitForServicesStable(fargateConfig.cluster, localStageConfig.service);
        if (stable) {
            logger.verbose(`   - service is stable`);
        } else {
            logger.verbose(`   - WARNING: service did not stabilize within timeout`);
        }
    } else {
        logger.verbose(`   - skipping stability wait (--no-wait)`);
    }

    return {
        cluster: fargateConfig.cluster,
        service: localStageConfig.service,
        taskDefinitionArn: serviceInfo.taskDefinitionArn,
        serviceStable: stable
    };
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
    processFargateDeploy,
    processFargateRestart,
    resolveFargateConfig,
    resolveVariable,
    setStageConfig};
