import {
    ExportConfig,
    FunctionConfig,
    WorkerFunctionConfig,
    FargateConfig,
    FargateDeployResult,
    FargateRestartResult,
    BatchConfig,
    BatchJobConfig,
    BatchDeployResult,
    BatchJobDeployResult,
    StageConfig,
    StageCloudFront,
    ThrottleSettings,
    EnvResult,
    APIFunctionResult,
    APIDeploymentResult,
    APIResult,
    SNSFunctionResult,
    SNSSubscriptionResult,
    SNSResult,
    SQSFunctionResult,
    SQSEventSourceResult,
    SQSResult,
    WorkerFunctionResult,
    WorkerResult,
    WebExportResult,
    WebResult,
    VersionInfo,
    DeploymentInfo
} from '../types';
import { Stage } from '@aws-sdk/client-api-gateway';
import { ContainerDefinition } from '@aws-sdk/client-ecs';

import * as lambda from './lambda';
import * as apigw from './apigw';
import * as sns from './sns';
import * as ecs from './ecs';
import * as batch from './batch';
import * as ecr from './ecr';
import * as cf from './cloudformation';
import * as s3 from './s3';
import * as cloudfront from './cloudfront';
import * as ps from './ps';
import * as path from 'path';
import * as github from './github';
import { getConfig } from './config';
import { buildCloudFrontFragment } from './cfn-cloudfront';
import * as awsContext from './aws-context';
import * as logger from './logger';

// All module caches live in a single state object so tests (and any future
// embedding) can reset the orchestrator between runs instead of inheriting
// whatever a previous deploy resolved.
interface CicdState {
    rawExports: Map<string, string>;
    exportMap: Map<string, ExportConfig>;
    functionMap: Map<string, FunctionConfig>;
    workerMap: Map<string, WorkerFunctionConfig>;
    envCache: Map<string, string> | null;
    psCache: Map<string, string>;
    stageConfig: StageConfig | null;
    exportsInitialized: boolean;
}

function freshState(): CicdState {
    return {
        rawExports: new Map(),
        exportMap: new Map(),
        functionMap: new Map(),
        workerMap: new Map(),
        envCache: null,
        psCache: new Map(),
        stageConfig: null,
        exportsInitialized: false,
    };
}

let state: CicdState = freshState();

function resetForTest(): void {
    state = freshState();
}

function requireStageConfig(): StageConfig {
    if (!state.stageConfig) {
        throw new Error('stageConfig not set — call setStageConfig() first');
    }
    return state.stageConfig;
}

async function init(): Promise<void> {
    if( !state.exportsInitialized ) {
        await initExports();
        state.exportsInitialized = true;
    }

    if( !state.envCache ) {
        await initEnvironment();
    }
}

async function getVar(key: string): Promise<string> {
    await init();
    if( !state.envCache!.has(key) ) {
        throw new Error(`Environment variable '${key}' not found in configuration`);
    }
    return state.envCache!.get(key)!;
}

async function expandVarNames(varNames: string): Promise<string[]> {
    const names = varNames.split(',').map(n => n.trim());
    const groups: Record<string, string[]> | undefined = await getConfig('environmentGroups');
    const expanded: string[] = [];
    for (const name of names) {
        if (name.startsWith('@')) {
            const groupName = name.substring(1);
            if (groups && groups[groupName]) {
                expanded.push(...groups[groupName]);
            } else {
                throw new Error(`Environment group '${groupName}' referenced but not defined in environmentGroups`);
            }
        } else {
            expanded.push(name);
        }
    }
    return expanded;
}

async function getVars(vars: string | string[] | undefined): Promise<Record<string, string> | null> {
    if( typeof vars === 'string' ) {
        vars = await expandVarNames(vars);
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
    if (key.startsWith('!ImportValue ')) {
        const importName = key.substring(13).trim();
        if (!state.rawExports.has(importName)) {
            throw new Error(`CloudFormation export '${importName}' not found (referenced by !ImportValue)`);
        }
        return state.rawExports.get(importName)!;
    }
    if (key.startsWith('!SetEnv ')) {
        const envName = key.substring(8).trim();
        const raw = process.env[envName];
        if (raw === undefined) {
            throw new Error(`Environment variable '${envName}' is not set in the current shell (referenced by !SetEnv)`);
        }
        return raw.replace(/\\"/g, '"').replace(/\\\\n/g, "\\n");
    }
    if (key.startsWith('!ParameterStore ')) {
        const psName = key.substring(16).trim();
        if (state.psCache.has(psName)) {
            return state.psCache.get(psName)!;
        }
        const fetched = await ps.getParameterValue(psName, true);
        if (fetched === null) {
            throw new Error(`Parameter Store value '${psName}' not found in this account/region (referenced by !ParameterStore)`);
        }
        const cleaned = fetched.replace(/\\"/g, '"').replace(/\\\\n/g, "\\n");
        state.psCache.set(psName, cleaned);
        return cleaned;
    }
    return key;
}

async function initEnvironmentVars(env: Record<string, string> | undefined, errors: string[], scope: string): Promise<void> {
    if (!env) {
        return;
    }
    for (const key of Object.keys(env)) {
        try {
            const val = await resolveVariable(env[key]);
            state.envCache!.set(key, val);
        } catch (e: any) {
            errors.push(`  ${scope}.${key} = '${env[key]}'\n      ${e.message || e}`);
        }
    }
}

async function setStageConfig(stage: string): Promise<void> {
    state.stageConfig = await getStageConfig(stage);
}

async function initEnvironment(): Promise<void> {
    state.envCache = new Map();
    const errors: string[] = [];

    // process primary variables
    const processVars = await getConfig("environment");
    await initEnvironmentVars(processVars, errors, 'environment');

    // process stage env vars
    if (state.stageConfig) {
        const stageVars = state.stageConfig.environment;
        await initEnvironmentVars(stageVars, errors, `stages[${state.stageConfig.stage}].environment`);
    }

    if (errors.length) {
        throw new Error(
            `Failed to resolve ${errors.length} environment variable${errors.length === 1 ? '' : 's'}:\n${errors.join('\n')}`
        );
    }
}

async function initExports(): Promise<void> {
    try {
        const exportConfigs: ExportConfig[] = (await getConfig('exports')) || [];
        for(const cfg of exportConfigs) {
            state.exportMap.set(cfg.name,cfg);
            if( cfg.functions ) {
                for(const f of cfg.functions) {
                    state.functionMap.set(f.name,f);
                }
            }
        }

        const workerConfigs: WorkerFunctionConfig[] = (await getConfig('workers')) || [];
        for(const w of workerConfigs) {
            state.workerMap.set(w.name,w);
        }

        // get exports and load them
        const response = await cf.listExports();
        for(const e of (response || [])) {
            if( state.exportMap.has(e.Name!) ) {
                const cfg = state.exportMap.get(e.Name!)!;
                cfg.value = e.Value;
            }else if( state.functionMap.has(e.Name!) ) {
                const cfg = state.functionMap.get(e.Name!)!;
                cfg.value = e.Value;
            }else if( state.workerMap.has(e.Name!) ) {
                const cfg = state.workerMap.get(e.Name!)!;
                cfg.value = e.Value;
            }
            state.rawExports.set(e.Name!,e.Value!);
        }

        // did we miss any exports in the config?
        let cnt = 0;
        for(const cfg of state.exportMap.values()) {
            if( !Object.prototype.hasOwnProperty.call(cfg, 'value') ) {
                logger.error(`ERROR: could not find export for '${cfg.name}'.`);
                cnt++;
            }
        }

        for(const cfg of state.functionMap.values()) {
            if( !Object.prototype.hasOwnProperty.call(cfg, 'value') ) {
                logger.error(`ERROR: could not find export for '${cfg.name}'.`);
                cnt++;
            }
        }

        for(const cfg of state.workerMap.values()) {
            if( !Object.prototype.hasOwnProperty.call(cfg, 'value') ) {
                logger.error(`ERROR: could not find export for '${cfg.name}'.`);
                cnt++;
            }
        }
        if( cnt ) {
            throw new Error(`${cnt} export(s) could not be resolved — see errors above`);
        }

        // update values for any items that don't have values
        for(const cfg of exportConfigs) {
            if( !cfg.value ) {
                const entry = state.exportMap.get(cfg.name)!;
                cfg.value = entry.value;
            }
            if( cfg.functions ) {
                for(const f of cfg.functions) {
                    if( !f.value ) {
                        const entry = state.functionMap.get(f.name)!;
                        f.value = entry.value;
                    }
                }
            }
        }

        for(const w of workerConfigs) {
            if( !w.value ) {
                const entry = state.workerMap.get(w.name)!;
                w.value = entry.value;
            }
        }

        // Resolve web exports' distribution CFN export to the CloudFront distribution ID.
        // Web exports carry two CFN export references: `name` (S3 bucket, resolved via the
        // standard state.exportMap path) and `distribution` (CloudFront distribution ID, resolved here).
        let webMissing = 0;
        for(const cfg of exportConfigs) {
            if (cfg.type !== 'web' || !cfg.distribution) continue;
            if (state.rawExports.has(cfg.distribution)) {
                cfg.distributionValue = state.rawExports.get(cfg.distribution);
            } else {
                logger.error(`ERROR: could not find export for web distribution '${cfg.distribution}'.`);
                webMissing++;
            }
        }
        if (webMissing) {
            throw new Error(`${webMissing} web distribution export(s) could not be resolved — see errors above`);
        }

        // Resolve each stage's CloudFront-mapping distribution CFN export to the
        // distribution ID (same pattern as web exports above). Stages live outside
        // state.exportMap, so resolve them directly from state.rawExports onto the stage config.
        const stageConfigsForCf: StageConfig[] = (await getConfig('stages')) || [];
        let stageCfMissing = 0;
        for (const sc of stageConfigsForCf) {
            if (!sc.cloudfront) continue;
            if (state.rawExports.has(sc.cloudfront.distribution)) {
                sc.cloudfront.distributionValue = state.rawExports.get(sc.cloudfront.distribution);
            } else {
                logger.error(`ERROR: could not find export for stage '${sc.stage}' cloudfront distribution '${sc.cloudfront.distribution}'.`);
                stageCfMissing++;
            }
        }
        if (stageCfMissing) {
            throw new Error(`${stageCfMissing} stage cloudfront distribution export(s) could not be resolved — see errors above`);
        }

    }catch(e) {
        throw new Error(`Failed to initialize exports: ${e instanceof Error ? e.message : e}`, { cause: e });
    }
}

async function getExportByName(name: string): Promise<ExportConfig | null> {
    await init();
    if( state.exportMap.has(name) ) {
        return state.exportMap.get(name)!;
    }
    return null;
}

async function getExportsByType(type: string, filter?: string): Promise<ExportConfig[]> {
    await init();
    // Read from the full config list rather than state.exportMap. state.exportMap is keyed by
    // CloudFormation export name, so multiple exports that legitimately share a
    // name — e.g. two web exports for the same S3 bucket but different CloudFront
    // distributions — collapse into one. init() has already resolved `value` and
    // `distributionValue` onto these same config objects, so the duplicates carry
    // their resolved values here.
    const exports: ExportConfig[] = (await getConfig('exports')) || [];
    return exports.filter( resource => resource.type === type && (!filter || resource.name === filter) );
}

async function getWorkers(stage?: string): Promise<WorkerFunctionConfig[]> {
    await init();
    const workers = [...state.workerMap.values()];
    if (stage) {
        return workers.filter(w => !w.stages || w.stages.includes(stage));
    }
    return workers;
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

async function findVersion(functionName: string, description: string): Promise<string> {
    const versions = await lambda.listVersions(functionName);
    for(const version of versions) {
        if( version.description === description ) {
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

async function findAliasExact(functionName: string, aliasName: string): Promise<{ alias: string; version: string; description?: string } | null> {
    const aliases = await lambda.listAliases(functionName);
    for(const alias of aliases) {
        if( alias.alias === aliasName ) {
            return { alias: alias.alias, version: alias.version, description: alias.description };
        }
    }
    return null;
}

async function findDeployment(apiId: string, commit: string): Promise<DeploymentInfo | null> {
    const deployments = await apigw.listDeployments(apiId);
    for(const deployment of deployments) {
        if( deployment.description && deployment.description.includes(commit) ) {
            return { id: deployment.id!, description: deployment.description };
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

function composeMappingPath(stageConfig: StageConfig, api: ExportConfig): string {
    const segments: string[] = [];
    if (stageConfig.mapping!.path) segments.push(stageConfig.mapping!.path);
    if (api.prefix) segments.push(api.prefix);
    if (api.path) segments.push(api.path);
    return segments.join('/');
}

// Composes the CloudFront path prefix an API is served under (no leading slash):
// {cloudfront.path|'api'}/{api.prefix}/{api.path}. The ordered cache behavior
// pattern is this joined with '/*' (see processApiGatewayApis).
function composeCloudFrontPath(cf: StageCloudFront, api: ExportConfig): string {
    const segments: string[] = [];
    const base = cf.path ?? 'api';
    if (base) segments.push(base);
    if (api.prefix) segments.push(api.prefix);
    if (api.path) segments.push(api.path);
    return segments.join('/');
}

interface BasePathMappingLite {
    basePath?: string;
    restApiId?: string;
    stage?: string;
}

type MappingDecision =
    | { action: 'existing' }
    | { action: 'create' }
    | { action: 'move'; from: string }
    | { action: 'conflict'; conflictApiId: string; conflictStage: string };

function normalizeBasePath(bp: string | undefined): string {
    if (!bp || bp === '(none)') return '';
    return bp;
}

function decideMappingAction(
    allMappings: BasePathMappingLite[],
    apiId: string,
    stage: string,
    desiredPath: string
): MappingDecision {
    const existing = allMappings.find(m => m.restApiId === apiId && m.stage === stage);
    if (existing) {
        const existingPath = normalizeBasePath(existing.basePath);
        if (existingPath === desiredPath) return { action: 'existing' };
        const conflict = allMappings.find(m =>
            normalizeBasePath(m.basePath) === desiredPath &&
            (m.restApiId !== apiId || m.stage !== stage)
        );
        if (conflict) {
            return { action: 'conflict', conflictApiId: conflict.restApiId!, conflictStage: conflict.stage! };
        }
        return { action: 'move', from: existingPath };
    }
    const conflict = allMappings.find(m => normalizeBasePath(m.basePath) === desiredPath);
    if (conflict) {
        return { action: 'conflict', conflictApiId: conflict.restApiId!, conflictStage: conflict.stage! };
    }
    return { action: 'create' };
}

async function processLambdaVersionAndAlias(
    functionName: string,
    appAlias: string,
    commit: string,
    concurrency?: number,
    dryRun: boolean = false
): Promise<{ action: 'created' | 'exists'; version: string }> {
    if (dryRun) {
        logger.verbose(`   - WOULD create version and alias '${appAlias}' for function '${functionName}'`);
        if (concurrency) {
            logger.verbose(`   - WOULD set concurrency to ${concurrency}`);
        }
        return { action: 'created', version: '(dry-run)' };
    }

    let version = await findVersion(functionName, appAlias);
    const alias = await findAlias(functionName, appAlias);
    if (alias) {
        logger.verbose(`   - alias for commit '${commit}' exists for function '${functionName}'`);
        if (concurrency) {
            await lambda.updateProvisionedConcurrency(functionName, appAlias, Number(concurrency));
            logger.verbose(`   - updating '${functionName}:${appAlias}' concurrency to ${concurrency}`);
        }
        return { action: 'exists', version };
    }

    if (!version) {
        const v = await lambda.publishNewVersion(functionName, appAlias) as VersionInfo;
        version = v.version;
        logger.verbose(`   - using version ${version} for '${commit}'`);
        const arn = v.arn.substring(0, v.arn.lastIndexOf(':'));
        const tags = await lambda.listFunctionTags(arn);
        if (tags.Commit !== commit) {
            logger.verbose(`   - creating alias '${appAlias}' for earlier version of function at commit '${tags.Commit}'`);
        }
    }
    await lambda.createAlias(functionName, appAlias, version);
    logger.verbose(`   - alias '${appAlias}' for commit '${commit}' created for function '${functionName}'`);
    if (concurrency) {
        await lambda.updateProvisionedConcurrency(functionName, appAlias, Number(concurrency));
        logger.verbose(`   - updating '${functionName}:${appAlias}' concurrency to ${concurrency}`);
    }
    return { action: 'created', version };
}

async function processWorkerVersionAndAlias(
    stage: string,
    commit: string,
    functionName: string,
    concurrency?: number,
    dryRun: boolean = false
): Promise<{ action: 'created' | 'updated' | 'exists'; version: string; commit: string }> {
    if (dryRun) {
        logger.verbose(`   - WOULD ensure stage alias '${stage}' points at version with commit '${commit}' for function '${functionName}'`);
        if (concurrency !== undefined) {
            logger.verbose(`   - WOULD set concurrency to ${concurrency}`);
        }
        return { action: 'created', version: '(dry-run)', commit };
    }

    let version = await findVersion(functionName, commit);
    const existing = await findAliasExact(functionName, stage);

    // Publish a new version if no version with this commit description exists yet.
    if (!version) {
        const v = await lambda.publishNewVersion(functionName, commit) as VersionInfo;
        version = v.version;
        logger.verbose(`   - published version ${version} for commit '${commit}'`);
    }

    // Track deployed commit via the alias Description (mutable) — version Description
    // is unreliable because PublishVersion returns the existing version when $LATEST
    // hasn't changed, leaving the old description in place.
    let action: 'created' | 'updated' | 'exists';
    if (!existing) {
        await lambda.createAlias(functionName, stage, version, commit);
        logger.verbose(`   - created stage alias '${stage}' → version ${version} on '${functionName}'`);
        action = 'created';
    } else if (existing.version === version) {
        if (existing.description !== commit) {
            await lambda.updateAlias(functionName, stage, version, commit);
            logger.verbose(`   - stage alias '${stage}' at version ${version}, refreshed commit '${existing.description}' → '${commit}' on '${functionName}'`);
            action = 'updated';
        } else {
            logger.verbose(`   - stage alias '${stage}' already at version ${version} commit '${commit}' on '${functionName}'`);
            action = 'exists';
        }
    } else {
        await lambda.updateAlias(functionName, stage, version, commit);
        logger.verbose(`   - re-pointed stage alias '${stage}' from version ${existing.version} → ${version} on '${functionName}'`);
        action = 'updated';
    }

    if (concurrency !== undefined) {
        await lambda.updateProvisionedConcurrency(functionName, stage, Number(concurrency));
        logger.verbose(`   - applied concurrency ${concurrency} on '${functionName}:${stage}'`);
    }

    return { action, version, commit };
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
        throw new Error(`No configuration found for stage '${stage}'`);
    }
    return foundConfig!;
}

async function processFunctionEnvironmentVars(dryRun: boolean = false): Promise<EnvResult[]> {
    const apiFunctions =  await getLambdaExports('api');
    const snsFunctions =  await getLambdaExports('sns');
    const sqsFunctions =  await getLambdaExports('sqs');
    const workerFunctions = await getWorkers(state.stageConfig?.stage);
    const functions = [...apiFunctions,...snsFunctions,...sqsFunctions,...workerFunctions];
    const results: EnvResult[] = [];
    logger.verbose(`\n * Creating environment vars for functions:`);
    for(const f of functions) {
        const functionName = f.value!;
        const funcEnv = await getVars(f.env);
        if( funcEnv ) {
            if (dryRun) {
                logger.verbose(`   - WOULD set ${Object.keys(funcEnv).length} environment vars for function: '${functionName}'`);
            } else {
                logger.verbose(`   - setting environment vars for function: '${functionName}'...`);
                await lambda.updateEnvironmentVariables(functionName,funcEnv);
            }
            results.push({ name: functionName, updated: true, varCount: Object.keys(funcEnv).length });
        } else {
            logger.verbose(`     x no vars for '${functionName}'`);
            results.push({ name: functionName, updated: false, varCount: 0 });
        }
    }
    return results;
}

async function processApiGatewayFunctions(stage: string, appAlias: string, commit: string, apiFilter?: string, dryRun: boolean = false): Promise<APIFunctionResult[]> {
    const functions =  await getLambdaExports('api',apiFilter);
    const results: APIFunctionResult[] = [];
    logger.verbose(`\n * Creating versions and aliases for functions:`);
    for(const f of functions) {
        logger.verbose(` * Checking function '${f.value}'...`);
        const { action, version } = await processLambdaVersionAndAlias(f.value!, appAlias, commit, f.concurrency, dryRun);
        results.push({ name: f.value!, action, version });
    }
    return results;
}

async function processApiGatewayApis(stage: string, appAlias: string, commit: string, apiFilter?: string, dryRun: boolean = false): Promise<APIDeploymentResult[]> {
    const account = await awsContext.getAccount();
    const region = await awsContext.getRegion();
    const globalThrottle: ThrottleSettings | undefined = await getConfig("throttle");
    const localStageConfig = await getStageConfig(stage);
    const apis = await getExportsByType('api',apiFilter);
    const results: APIDeploymentResult[] = [];
    logger.verbose(`\n * Updating apis to deploy stage and ensure custom domain mappings:`);
    for(const api of apis) {
        const apiId = api.value!;
        logger.verbose(` * Checking api ${api.name} [${api.value}]...`);
        if (dryRun) {
            const targets: string[] = [];
            if (localStageConfig.mapping) {
                targets.push(`map to ${localStageConfig.mapping.domain}/${composeMappingPath(localStageConfig, api)}`);
            }
            if (localStageConfig.cloudfront) {
                const cf = localStageConfig.cloudfront;
                targets.push(`serve via CloudFront ${cf.distribution} at /${composeCloudFrontPath(cf, api)}/*`);
            }
            logger.verbose(`   - WOULD create deployment, update stage '${stage}'${targets.length ? ', ' + targets.join(' and ') : ''}`);
            results.push({
                name: api.name,
                deployment: 'created',
                stage: 'created',
                mapping: localStageConfig.mapping ? 'created' : 'skipped',
                cloudfront: localStageConfig.cloudfront ? 'ok' : undefined,
                throttle: 'dry-run',
                functions: api.functions!.length
            });
            continue;
        }
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

        // Custom-domain base-path mapping. Skipped when the stage has no `mapping`
        // (e.g. a CloudFront-only stage); the API stage deploy above still happens.
        let mappingAction: 'created' | 'existing' | 'moved' | 'skipped' = 'skipped';
        if (localStageConfig.mapping) {
            const path = composeMappingPath(localStageConfig, api);
            const domain = localStageConfig.mapping.domain;
            const allMappings = await apigw.listBasePathMappings(domain);
            const decision = decideMappingAction(allMappings, apiId, stage, path);
            mappingAction = 'existing';
            if (decision.action === 'conflict') {
                throw new Error(
                    `Base path '${path}' on domain ${domain} is already mapped to a different api (restApiId=${decision.conflictApiId}, stage=${decision.conflictStage}). ` +
                    `Refusing to overwrite. Remove the conflicting mapping or rename '${api.name}'s composed path.`
                );
            } else if (decision.action === 'existing') {
                logger.verbose(`   - using existing mapping for ${domain} with path '${path}'`);
            } else if (decision.action === 'move') {
                logger.verbose(`   - moving mapping for ${domain}: '${decision.from}' → '${path}'`);
                await apigw.deleteBasePathMapping(domain, decision.from);
                await apigw.createCustomDomainMappingV2(domain, apiId, stage, path);
                mappingAction = 'moved';
            } else {
                logger.verbose(`   - create mapping for ${domain} with path '${path}'`);
                try {
                    await apigw.createCustomDomainMappingV2(domain, apiId, stage, path);
                    mappingAction = 'created';
                } catch (e: any) {
                    // Only a conflict means the mapping already exists; anything else
                    // (bad domain, permissions, ...) must fail the deploy.
                    if (e?.name !== 'ConflictException') throw e;
                    logger.verbose(`   x mapping for ${domain} with path '${path}' already exists`);
                }
            }
        }

        // CloudFront mapping: read-only drift check. The origin + behavior are owned
        // by CloudFormation; warn (and print the fragment) if they're missing/drifted.
        let cloudfrontAction: 'ok' | 'drift' | 'missing' | undefined = undefined;
        if (localStageConfig.cloudfront) {
            cloudfrontAction = await checkCloudFrontDrift(stage, localStageConfig.cloudfront, api, region);
        }

        // update permissions for functions
        for(const f of api.functions!) {
            logger.verbose(`   - updating permissions for '${f.name}'`);
            const functionName = f.value!;
            const functionArn = `arn:aws:lambda:${region}:${account}:function:${functionName}:${appAlias}`;
            const sourceArn = `arn:aws:execute-api:${region}:${account}:${apiId}/*/${f.method}/*`;
            await lambda.addFunctionPermission(functionArn, sourceArn,'apigateway.amazonaws.com');
        }

        results.push({
            name: api.name,
            deployment: deploymentAction,
            stage: stageAction,
            mapping: mappingAction,
            cloudfront: cloudfrontAction,
            throttle: throttleLabel,
            functions: api.functions!.length
        });
    }

    // CloudFront cache invalidation: one invalidation per stage covers every API
    // under the path prefix (e.g. /api/*). Default on; opt out with invalidate:false.
    const cf = localStageConfig.cloudfront;
    if (cf && apis.length > 0) {
        const invPath = `/${cf.path ?? 'api'}/*`;
        if (dryRun) {
            logger.verbose(`   - WOULD invalidate '${invPath}' on distribution '${cf.distribution}'`);
        } else if (cf.invalidate !== false) {
            const id = await cloudfront.createInvalidation(cf.distributionValue!, [invPath]);
            logger.verbose(`   - invalidation '${id}' created on ${cf.distributionValue} for '${invPath}'`);
        } else {
            logger.verbose(`   - skipping invalidation for '${invPath}' (invalidate:false)`);
        }
    }

    return results;
}

// Read-only CloudFront drift check for a single API on a CloudFront-mapped stage.
// Never fails the deploy — warns (and prints the CFN fragment to add) when the
// distribution is missing the expected behavior, or its origin path / cache
// policy don't match. Mirrors warnIfOriginPathDrift's never-fail philosophy.
async function checkCloudFrontDrift(stage: string, cf: StageCloudFront, api: ExportConfig, region: string): Promise<'ok' | 'drift' | 'missing'> {
    const distId = cf.distributionValue!;
    const pathPattern = `/${composeCloudFrontPath(cf, api)}/*`;
    const expectedOriginPath = `/${stage}`;
    try {
        const behavior = await cloudfront.getCacheBehavior(distId, pathPattern);
        if (!behavior) {
            logger.warn(`   ! WARNING: CloudFront distribution ${distId} has no cache behavior '${pathPattern}' for api '${api.name}'. Add the following to CloudFormation (or run: cicd cloudfront ${stage}):`);
            const fragment = buildCloudFrontFragment({
                stage,
                apis: [{ name: api.name, apiId: api.value!, region, pathPattern, exportName: api.name }],
                cachePolicy: cf.cachePolicy,
                format: 'yaml'
            });
            logger.warn(fragment);
            return 'missing';
        }
        if (behavior.originPath !== null && behavior.originPath !== expectedOriginPath) {
            logger.warn(`   ! WARNING: CloudFront behavior '${pathPattern}' origin OriginPath is '${behavior.originPath}', expected '${expectedOriginPath}'. Update CloudFormation.`);
            return 'drift';
        }
        if (cf.cachePolicy && behavior.cachePolicyId && behavior.cachePolicyId !== cf.cachePolicy) {
            logger.warn(`   ! WARNING: CloudFront behavior '${pathPattern}' CachePolicyId is '${behavior.cachePolicyId}', expected '${cf.cachePolicy}'.`);
            return 'drift';
        }
        logger.verbose(`   - cloudfront behavior '${pathPattern}' → OriginPath '${behavior.originPath}' OK`);
        return 'ok';
    } catch (e: any) {
        logger.warn(`   ! WARNING: cloudfront drift check skipped for ${api.name}: ${e.message}`);
        return 'ok';
    }
}

async function processApiGateway(stage: string, appAlias: string, commit: string, apiFilter?: string, dryRun: boolean = false): Promise<APIResult> {
    const functions = await processApiGatewayFunctions(stage,appAlias,commit,apiFilter,dryRun);
    const apis = await processApiGatewayApis(stage,appAlias,commit,apiFilter,dryRun);
    return { functions, apis };
}

async function processSNSFunctions(stage: string, appAlias: string, commit: string, dryRun: boolean = false): Promise<SNSFunctionResult[]> {
    const functions =  await getLambdaExports('sns');
    const results: SNSFunctionResult[] = [];
    logger.verbose(`\nCreating versions and aliases for functions:`);
    for(const f of functions) {
        logger.verbose(` * Checking function '${f.value}'...`);
        const { action, version } = await processLambdaVersionAndAlias(f.value!, appAlias, commit, undefined, dryRun);
        results.push({ name: f.value!, action, version });
    }
    return results;
}

async function processSNSSubscriptions(stage: string, appAlias: string, commit: string, dryRun: boolean = false): Promise<SNSSubscriptionResult[]> {
    const account = await awsContext.getAccount();
    const region = await awsContext.getRegion();
    const topics = await getExportsByType('sns');
    const results: SNSSubscriptionResult[] = [];
    logger.verbose(`\n * Updating SNS subscriptions:`);
    for(const topic of topics) {

        // checking sns for stage
        if( Object.prototype.hasOwnProperty.call(topic, 'stages') ) {
            if( !topic.stages!.includes(requireStageConfig().stage) ) {
                logger.verbose(`   - skipping '${topic.name}' in '${requireStageConfig().stage}'`);
                results.push({ name: topic.name, action: 'skipped' });
                continue;
            }
        }

        if (dryRun) {
            for (const f of topic.functions!) {
                logger.verbose(`   - WOULD subscribe '${f.value}' to SNS topic '${topic.name}'`);
            }
            results.push({ name: topic.name, action: 'subscribed', oldRemoved: 0 });
            continue;
        }

        let oldRemoved = 0;
        for(const f of topic.functions!) {
            logger.verbose(`   - updating permissions for '${f.name}'`);
            const functionName = f.value!;
            const functionArn = `arn:aws:lambda:${region}:${account}:function:${functionName}:${appAlias}`;
            await lambda.addFunctionPermission(functionArn, topic.value!,'sns.amazonaws.com');

            // cleaning up existing subscriptions
            const subscriptions = await sns.listSubscriptionsByTopic(topic.value!);
            for(const subscription of subscriptions) {
                const parts = subscription.endpoint.split(':');
                if( parts.length === 8 && parts[7] !== appAlias ) {
                    logger.verbose(`   - deleting old subscription to SNS topic '${topic.name}'`);
                    await sns.deleteSubscription(subscription.subscriptionArn);
                    oldRemoved++;
                }
            }

            logger.verbose(`   - subscribing lambda to SNS topic '${topic.name}'`);
            await sns.subscribeLambdaToTopic(topic.value!,functionArn);
        }
        results.push({ name: topic.name, action: 'subscribed', oldRemoved });
    }
    return results;
}

async function processSNS(stage: string, appAlias: string, commit: string, dryRun: boolean = false): Promise<SNSResult | null> {
    const topics = await getExportsByType('sns');
    if (topics.length === 0) {
        return null;
    }
    logger.verbose(`\nUpdating sns topics:`);
    const functions = await processSNSFunctions(stage,appAlias,commit,dryRun);
    const subscriptions = await processSNSSubscriptions(stage,appAlias,commit,dryRun);
    return { functions, subscriptions };
}

async function processSQSFunctions(stage: string, appAlias: string, commit: string, dryRun: boolean = false): Promise<SQSFunctionResult[]> {
    const functions = await getLambdaExports('sqs');
    const results: SQSFunctionResult[] = [];
    logger.verbose(`\nCreating versions and aliases for functions:`);
    for(const f of functions) {
        logger.verbose(` * Checking function '${f.value}'...`);
        const { action, version } = await processLambdaVersionAndAlias(f.value!, appAlias, commit, f.concurrency, dryRun);
        results.push({ name: f.value!, action, version });
    }
    return results;
}

async function processSQSEventSources(stage: string, appAlias: string, commit: string, dryRun: boolean = false): Promise<SQSEventSourceResult[]> {
    const account = await awsContext.getAccount();
    const region = await awsContext.getRegion();
    const queues = await getExportsByType('sqs');
    const results: SQSEventSourceResult[] = [];
    logger.verbose(`\n * Updating SQS event source mappings:`);
    for(const queue of queues) {

        // checking sqs for stage
        if( Object.prototype.hasOwnProperty.call(queue, 'stages') ) {
            if( !queue.stages!.includes(requireStageConfig().stage) ) {
                logger.verbose(`   - skipping '${queue.name}' in '${requireStageConfig().stage}'`);
                results.push({ name: queue.name, action: 'skipped' });
                continue;
            }
        }

        if (dryRun) {
            for (const f of queue.functions!) {
                logger.verbose(`   - WOULD map '${f.value}' to SQS queue '${queue.name}'`);
            }
            results.push({ name: queue.name, action: 'created', oldRemoved: 0 });
            continue;
        }

        let oldRemoved = 0;
        let perQueueAction: 'created' | 'updated' | 'exists' = 'exists';
        for(const f of queue.functions!) {
            const functionName = f.value!;
            const functionArn = `arn:aws:lambda:${region}:${account}:function:${functionName}:${appAlias}`;
            const desiredOpts = {
                batchSize: f.batchSize,
                maximumBatchingWindowInSeconds: f.maximumBatchingWindowInSeconds,
                maximumConcurrency: f.maximumConcurrency
            };

            const mappings = await lambda.listEventSourceMappings(queue.value!);

            // remove mappings that point at a different alias of this function
            let currentMapping: typeof mappings[number] | undefined = undefined;
            for(const m of mappings) {
                const parts = m.functionArn.split(':');
                const isThisFunction = parts.length >= 7 && parts[6] === functionName;
                if (!isThisFunction) continue;
                if (parts.length === 8 && parts[7] === appAlias) {
                    currentMapping = m;
                } else {
                    logger.verbose(`   - deleting old event source mapping for '${functionName}' on SQS queue '${queue.name}'`);
                    await lambda.deleteEventSourceMapping(m.uuid);
                    oldRemoved++;
                }
            }

            if (currentMapping) {
                const drifted = (desiredOpts.batchSize !== undefined && currentMapping.batchSize !== desiredOpts.batchSize)
                    || (desiredOpts.maximumBatchingWindowInSeconds !== undefined && currentMapping.maximumBatchingWindowInSeconds !== desiredOpts.maximumBatchingWindowInSeconds)
                    || (desiredOpts.maximumConcurrency !== undefined && currentMapping.maximumConcurrency !== desiredOpts.maximumConcurrency);
                if (drifted) {
                    logger.verbose(`   - updating event source mapping for '${functionName}' on SQS queue '${queue.name}'`);
                    await lambda.updateEventSourceMapping(currentMapping.uuid, desiredOpts);
                    if (perQueueAction !== 'created') perQueueAction = 'updated';
                } else {
                    logger.verbose(`   - event source mapping already current for '${functionName}' on SQS queue '${queue.name}'`);
                }
            } else {
                logger.verbose(`   - creating event source mapping for '${functionName}' on SQS queue '${queue.name}'`);
                await lambda.createEventSourceMapping(queue.value!, functionArn, desiredOpts);
                perQueueAction = 'created';
            }
        }
        results.push({ name: queue.name, action: perQueueAction, oldRemoved });
    }
    return results;
}

async function processSQS(stage: string, appAlias: string, commit: string, dryRun: boolean = false): Promise<SQSResult | null> {
    const queues = await getExportsByType('sqs');
    if (queues.length === 0) {
        return null;
    }
    logger.verbose(`\nUpdating sqs queues:`);
    const functions = await processSQSFunctions(stage,appAlias,commit,dryRun);
    const eventSources = await processSQSEventSources(stage,appAlias,commit,dryRun);
    return { functions, eventSources };
}

const NOINDEX_ROBOTS_BODY = 'User-agent: *\nDisallow: /\n';
const NOCACHE = 'no-cache, no-store, must-revalidate';

// Relative-path prefixes under `{stage}/live/` whose objects are NOT pruned when a
// new build is swapped in. These hold content-hashed, immutable build assets (Vite
// emits them under `assets/`). Retaining them means a viewer whose browser still
// holds a briefly-cached older HTML can keep loading the hashed chunks that HTML
// references for the lifetime of that cached HTML, instead of hitting a 404.
const RETAINED_LIVE_PREFIXES = ['assets/'];

// Key for the live-commit marker. Lives directly under the stage prefix — NOT
// under `{stage}/live/` — so the static `/{stage}/live` origin can never serve
// it. GitHub deployments are the source of truth; this marker is a backup that
// records what the last successful swap actually placed into `live/`.
function liveMarkerKey(stage: string): string {
    return `${stage}/.cicd-live.json`;
}

// Read-only safety check. The CLI no longer mutates the distribution — the
// origin path is expected to be a static `/{stage}/live` set in CloudFormation.
// Warn (never change) if a distribution still points elsewhere, e.g. an
// unmigrated `/{stage}/{commit}` path. Never fails the deploy.
async function warnIfOriginPathDrift(distribution: string, stage: string, expected: string): Promise<void> {
    try {
        const op = await cloudfront.getOriginPath(distribution, stage);
        if (op !== null && op !== expected) {
            logger.warn(`   ! WARNING: CloudFront origin '${stage}' OriginPath is '${op}', expected '${expected}'. Update CloudFormation to point this origin at '${expected}'.`);
        }
    } catch (e: any) {
        logger.warn(`   ! WARNING: origin-path drift check skipped for ${stage}: ${e.message}`);
    }
}

async function processWeb(stage: string, appAlias: string, commit: string, webFilter?: string, dryRun: boolean = false): Promise<WebResult | null> {
    const all = await getExportsByType('web', webFilter);
    if (all.length === 0) {
        return null;
    }
    logger.verbose(`\nUpdating web deployments:`);

    const exports: WebExportResult[] = [];
    for (const cfg of all) {
        if (cfg.stages && !cfg.stages.includes(stage)) {
            logger.verbose(`   - skipping web '${cfg.name}' in '${stage}' (not in stages list)`);
            continue;
        }

        const bucket = cfg.value!;
        const distribution = cfg.distributionValue!;
        const source = path.resolve(process.cwd(), cfg.source ?? './dist');
        const commitPrefix = `${stage}/${commit}`;
        const livePrefix = `${stage}/live`;
        const staticOrigin = `/${stage}/live`;
        const markerKey = liveMarkerKey(stage);
        const noindex = !!(cfg.noindexStages && cfg.noindexStages.includes(stage));

        logger.verbose(` * Web '${cfg.name}' → s3://${bucket}/${commitPrefix}/ then live at s3://${bucket}/${livePrefix}/  (distribution ${distribution})`);

        await warnIfOriginPathDrift(distribution, stage, staticOrigin);

        if (dryRun) {
            logger.verbose(`   - WOULD upload '${source}' to s3://${bucket}/${commitPrefix}/`);
            if (noindex) {
                logger.verbose(`   - WOULD inject Disallow:/ robots.txt for noindex stage '${stage}'`);
            }
            logger.verbose(`   - WOULD sync s3://${bucket}/${commitPrefix}/ → s3://${bucket}/${livePrefix}/ (copy then prune; ${RETAINED_LIVE_PREFIXES.join(', ')} retained)`);
            logger.verbose(`   - WOULD write live marker s3://${bucket}/${markerKey} (commit ${commit})`);
            logger.verbose(`   - WOULD invalidate /* on distribution '${distribution}'`);
            exports.push({
                name: cfg.name,
                bucket,
                distribution,
                liveCommit: commit,
                livePath: staticOrigin,
                fileCount: 0,
                totalBytes: 0,
                noindexInjected: noindex
            });
            continue;
        }

        const cacheControlFor = s3.makeCacheControl(cfg.cacheControl);
        const { fileCount, totalBytes } = await s3.uploadDirectory(bucket, commitPrefix, source, undefined, cacheControlFor);
        logger.verbose(`   - uploaded ${fileCount} files (${totalBytes} bytes)`);

        if (noindex) {
            await s3.putObject(bucket, `${commitPrefix}/robots.txt`, NOINDEX_ROBOTS_BODY, 'text/plain; charset=utf-8', NOCACHE);
            logger.verbose(`   - injected Disallow:/ robots.txt for noindex stage '${stage}'`);
        }

        const synced = await s3.syncPrefix(bucket, `${commitPrefix}/`, `${livePrefix}/`, RETAINED_LIVE_PREFIXES);
        logger.verbose(`   - synced ${synced} object(s) to s3://${bucket}/${livePrefix}/`);

        await s3.putObject(bucket, markerKey, JSON.stringify({ commit, deployedAt: new Date().toISOString() }), 'application/json; charset=utf-8', NOCACHE);
        logger.verbose(`   - wrote live marker s3://${bucket}/${markerKey} (commit ${commit})`);

        const invalidationId = await cloudfront.createInvalidation(distribution, ['/*']);
        logger.verbose(`   - invalidation '${invalidationId}' created`);

        exports.push({
            name: cfg.name,
            bucket,
            distribution,
            liveCommit: commit,
            livePath: staticOrigin,
            invalidationId,
            fileCount,
            totalBytes,
            noindexInjected: noindex
        });
    }

    // Web exports are configured but every one of them is scoped (via `stages`)
    // to other stages, so this deploy uploaded nothing. Surface it loudly — a
    // silent empty result would otherwise be reported as a successful deploy.
    if (exports.length === 0) {
        const scoped = all.map(c => `${c.name} → [${(c.stages || ['*']).join(', ')}]`).join('; ');
        logger.warn(`   ! WARNING: no web export applies to stage '${stage}' — nothing was uploaded. Configured web exports: ${scoped}`);
    }

    return { exports };
}

// Web rollback restores a previously-deployed artifact rather than re-uploading
// the current working tree. The target commit's objects already live at
// s3://{bucket}/{stage}/{commit}/ from its original deploy, so rollback re-syncs
// that prefix into the static `{stage}/live/` directory, rewrites the live
// marker, and invalidates — no upload, and the distribution is never touched.
// Errors clearly if the prefix is gone (e.g. pruned by `clean`).
async function processWebRollback(stage: string, commit: string, webFilter?: string, dryRun: boolean = false): Promise<WebResult | null> {
    const all = await getExportsByType('web', webFilter);
    if (all.length === 0) {
        return null;
    }
    logger.verbose(`\nRolling back web deployments:`);

    const exports: WebExportResult[] = [];
    for (const cfg of all) {
        if (cfg.stages && !cfg.stages.includes(stage)) {
            logger.verbose(`   - skipping web '${cfg.name}' in '${stage}' (not in stages list)`);
            continue;
        }

        const bucket = cfg.value!;
        const distribution = cfg.distributionValue!;
        const commitPrefix = `${stage}/${commit}`;
        const livePrefix = `${stage}/live`;
        const staticOrigin = `/${stage}/live`;
        const markerKey = liveMarkerKey(stage);

        // The artifact must already exist in S3 — rollback restores it, never uploads.
        const keys = await s3.listObjectsByPrefix(bucket, `${commitPrefix}/`);
        if (keys.length === 0) {
            throw new Error(
                `Cannot roll back web '${cfg.name}' to '${commit}': no objects at s3://${bucket}/${commitPrefix}/ ` +
                `(the artifact may have been pruned by 'clean'). Re-deploy that commit instead.`
            );
        }

        logger.verbose(` * Web '${cfg.name}' → restore s3://${bucket}/${commitPrefix}/ to s3://${bucket}/${livePrefix}/  (distribution ${distribution})`);

        await warnIfOriginPathDrift(distribution, stage, staticOrigin);

        if (dryRun) {
            logger.verbose(`   - WOULD sync s3://${bucket}/${commitPrefix}/ → s3://${bucket}/${livePrefix}/ (${keys.length} existing objects)`);
            logger.verbose(`   - WOULD write live marker s3://${bucket}/${markerKey} (commit ${commit}, restored)`);
            logger.verbose(`   - WOULD invalidate /* on distribution '${distribution}'`);
            exports.push({
                name: cfg.name,
                bucket,
                distribution,
                liveCommit: commit,
                livePath: staticOrigin,
                fileCount: keys.length,
                totalBytes: 0,
                noindexInjected: false,
                restored: true
            });
            continue;
        }

        const synced = await s3.syncPrefix(bucket, `${commitPrefix}/`, `${livePrefix}/`, RETAINED_LIVE_PREFIXES);
        logger.verbose(`   - synced ${synced} object(s) to s3://${bucket}/${livePrefix}/`);

        await s3.putObject(bucket, markerKey, JSON.stringify({ commit, deployedAt: new Date().toISOString(), restored: true }), 'application/json; charset=utf-8', NOCACHE);
        logger.verbose(`   - wrote live marker s3://${bucket}/${markerKey} (commit ${commit}, restored)`);

        const invalidationId = await cloudfront.createInvalidation(distribution, ['/*']);
        logger.verbose(`   - invalidation '${invalidationId}' created`);

        exports.push({
            name: cfg.name,
            bucket,
            distribution,
            liveCommit: commit,
            livePath: staticOrigin,
            invalidationId,
            fileCount: keys.length,
            totalBytes: 0,
            noindexInjected: false,
            restored: true
        });
    }

    return { exports };
}

async function processWorkers(stage: string, commit: string, dryRun: boolean = false): Promise<WorkerResult | null> {
    const workers = await getWorkers();
    if (workers.length === 0) {
        return null;
    }
    logger.verbose(`\nUpdating workers:`);
    const results: WorkerFunctionResult[] = [];
    for (const w of workers) {
        if (w.stages && !w.stages.includes(stage)) {
            logger.verbose(`   - skipping worker '${w.name}' in '${stage}'`);
            results.push({ name: w.value || w.name, action: 'skipped', version: '' });
            continue;
        }
        logger.verbose(` * Checking worker '${w.value}'...`);
        const { action, version, commit: resolvedCommit } = await processWorkerVersionAndAlias(stage, commit, w.value!, w.concurrency, dryRun);
        results.push({ name: w.value!, action, version, commit: resolvedCommit });
    }
    return { functions: results };
}

async function resolveFargateConfig(): Promise<{ cluster: string; ecrRepository: string; containerName: string; httpApi?: string }> {
    const fargate: FargateConfig | undefined = await getConfig('fargate');
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
    logger.verbose(`   - current state: desired=${serviceInfo.desiredCount}, running=${serviceInfo.runningCount}, status=${serviceInfo.status}`);
    logger.verbose(`   - current task definition: ${serviceInfo.taskDefinitionArn}`);

    // 2. Get current task definition for copying
    const currentTaskDef = await ecs.describeTaskDefinition(serviceInfo.taskDefinitionArn);

    // 3. Build merged environment variables
    const resolvedEnvVars: Record<string, string> = {};
    if (state.envCache) {
        for (const [key, val] of state.envCache) {
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
    const overrides = (localStageConfig.cpu || localStageConfig.memory)
        ? { cpu: localStageConfig.cpu, memory: localStageConfig.memory }
        : undefined;
    const newTaskDefArn = await ecs.registerTaskDefinition(taskDefWithFamily, newContainerDefs, overrides);
    logger.verbose(`   - registered new task definition: ${newTaskDefArn}`);
    if (overrides) {
        logger.verbose(`   - cpu: ${overrides.cpu || currentTaskDef.cpu}, memory: ${overrides.memory || currentTaskDef.memory}`);
    }

    // 6. Update service
    await ecs.updateService(fargateConfig.cluster, localStageConfig.service, newTaskDefArn);
    logger.verbose(`   - service updated to new task definition`);

    // 7. Wait for stability
    logger.verbose(`   - waiting for service stability...`);
    const stabilityResult = await ecs.waitForServicesStable(fargateConfig.cluster, localStageConfig.service);

    let rolledBack = false;

    if (stabilityResult.stable) {
        logger.verbose(`   - service is stable`);
    } else if (stabilityResult.failed) {
        logger.verbose(`   - DEPLOYMENT FAILED: ${stabilityResult.failureReason}`);
        if (stabilityResult.stoppedTaskReasons?.length) {
            for (const reason of stabilityResult.stoppedTaskReasons) {
                logger.verbose(`     stopped task: ${reason}`);
            }
        }
        // Auto-rollback to previous task definition
        logger.verbose(`   - rolling back to previous task definition: ${serviceInfo.taskDefinitionArn}`);
        await ecs.updateService(fargateConfig.cluster, localStageConfig.service, serviceInfo.taskDefinitionArn);
        logger.verbose(`   - rollback initiated, waiting for stability...`);
        const rollbackResult = await ecs.waitForServicesStable(fargateConfig.cluster, localStageConfig.service);
        if (rollbackResult.stable) {
            logger.verbose(`   - rollback complete, service is stable`);
        } else {
            logger.verbose(`   - WARNING: rollback did not stabilize within timeout`);
        }
        rolledBack = true;
    } else {
        logger.verbose(`   - WARNING: service did not stabilize within timeout`);
        if (stabilityResult.stoppedTaskReasons?.length) {
            for (const reason of stabilityResult.stoppedTaskReasons) {
                logger.verbose(`     stopped task: ${reason}`);
            }
        }
    }

    // 8. Ensure HTTP API custom domain mapping
    // httpApi can be defined at stage level (per-stage APIs) or top-level fargate config (shared API)
    let httpApi = fargateConfig.httpApi;
    if (localStageConfig.httpApi) {
        httpApi = (await resolveVariable(localStageConfig.httpApi)) || localStageConfig.httpApi;
    }

    if (httpApi && localStageConfig.mapping) {
        const domain = localStageConfig.mapping.domain;
        const path = localStageConfig.mapping.path;
        logger.verbose(`\n * Checking HTTP API mapping for ${domain} with path '${path}':`);

        const existingMappings = await apigw.listApiMappingsV2(domain);
        const existing = existingMappings.find((m: any) =>
            m.ApiId === httpApi && (m.ApiMappingKey || '') === (path || '')
        );

        if (existing) {
            logger.verbose(`   - mapping already exists for ${domain}/${path}`);
        } else {
            logger.verbose(`   - creating mapping for ${domain} with path '${path}'`);
            try {
                await apigw.createCustomDomainMappingV2(domain, httpApi!, '$default', path);
                logger.verbose(`   - mapping created`);
            } catch (e: any) {
                if (e?.name !== 'ConflictException') throw e;
                logger.verbose(`   x mapping for ${domain} with path '${path}' already exists`);
            }
        }
    }

    return {
        taskDefinitionArn: newTaskDefArn,
        previousTaskDefinitionArn: serviceInfo.taskDefinitionArn,
        image,
        serviceStable: stabilityResult.stable,
        deploymentFailed: stabilityResult.failed,
        failureReason: stabilityResult.failureReason,
        stoppedTaskReasons: stabilityResult.stoppedTaskReasons,
        rolledBack
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
    logger.verbose(`   - current state: desired=${serviceInfo.desiredCount}, running=${serviceInfo.runningCount}, status=${serviceInfo.status}`);
    logger.verbose(`   - current task definition: ${serviceInfo.taskDefinitionArn}`);

    // 2. Force new deployment
    await ecs.forceUpdateService(fargateConfig.cluster, localStageConfig.service);
    logger.verbose(`   - force new deployment triggered`);

    // 3. Wait for stability (unless --no-wait)
    let stable = true;
    if (!noWait) {
        logger.verbose(`   - waiting for service stability...`);
        const stabilityResult = await ecs.waitForServicesStable(fargateConfig.cluster, localStageConfig.service);
        stable = stabilityResult.stable;
        if (stabilityResult.stable) {
            logger.verbose(`   - service is stable`);
        } else if (stabilityResult.failed) {
            logger.verbose(`   - RESTART FAILED: ${stabilityResult.failureReason}`);
            if (stabilityResult.stoppedTaskReasons?.length) {
                for (const reason of stabilityResult.stoppedTaskReasons) {
                    logger.verbose(`     stopped task: ${reason}`);
                }
            }
        } else {
            logger.verbose(`   - WARNING: service did not stabilize within timeout`);
            if (stabilityResult.stoppedTaskReasons?.length) {
                for (const reason of stabilityResult.stoppedTaskReasons) {
                    logger.verbose(`     stopped task: ${reason}`);
                }
            }
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

// Build the per-stage keep set: the last N successful GitHub deployments per stage,
// expressed as bare short commit SHAs. Used by clean (what to keep) and rollback
// (what's recoverable).
async function buildKeepSet(n: number = 5): Promise<Map<string, Set<string>>> {
    const repo = await getConfig('repo');
    const stages: StageConfig[] = await getConfig('stages');
    const keep = new Map<string, Set<string>>();
    for (const s of stages) keep.set(s.stage, new Set<string>());
    if (!repo) {
        logger.verbose(`   - 'repo' not configured; keep set is empty for all stages`);
        return keep;
    }
    for (const s of stages) {
        // Pull more than n then filter — successful deployments are interleaved with failures.
        const fetched = github.listDeployments(repo, s.stage, n * 4);
        const successful = fetched.filter(d => d.status === 'success' || d.status === 'inactive');
        const set = keep.get(s.stage)!;
        for (const d of successful.slice(0, n)) set.add(d.ref);
    }
    return keep;
}

// Extract the bare commit from an alias name (`{app}-{commit}`). Returns the input
// unchanged if there's no `-`.
function commitFromAlias(alias: string): string {
    const idx = alias.indexOf('-');
    return idx >= 0 ? alias.substring(idx + 1) : alias;
}

// Union of commits across stages — used for artifacts shared across stages
// (Lambda aliases, ECR images).
function unionKeep(keep: Map<string, Set<string>>, stageNames: Iterable<string>): Set<string> {
    const out = new Set<string>();
    for (const s of stageNames) {
        const set = keep.get(s);
        if (set) for (const c of set) out.add(c);
    }
    return out;
}

async function validateRollbackTarget(appAlias: string, stage?: string, commit?: string): Promise<{ valid: boolean; warnings: string[] }> {
    const warnings: string[] = [];
    const apiFunctions = await getLambdaExports('api');
    const snsFunctions = await getLambdaExports('sns');
    const sqsFunctions = await getLambdaExports('sqs');
    const allFunctions = [...apiFunctions, ...snsFunctions, ...sqsFunctions];

    for (const f of allFunctions) {
        const functionName = f.value!;
        const alias = await findAlias(functionName, appAlias);
        if (!alias) {
            warnings.push(`Alias '${appAlias}' not found for ${functionName} — will create from $LATEST`);
        }
    }

    // Workers use stage-as-alias semantics: a stage alias is created on first deploy and re-pointed
    // thereafter. For rollback, the concern is whether a version with the target commit description
    // still exists (it may have been pruned by `clean`). If missing, the deploy will publish a new
    // version from $LATEST — which will NOT be the historical code at that commit.
    if (stage && commit) {
        const workers = await getWorkers(stage);
        for (const w of workers) {
            const functionName = w.value!;
            const version = await findVersion(functionName, commit);
            if (!version) {
                warnings.push(`Worker '${functionName}': no version with commit '${commit}' found (likely pruned). Rollback will publish from $LATEST — NOT the historical code.`);
            }
        }
    }

    return { valid: warnings.length === 0, warnings };
}

async function getCurrentStageConfig(): Promise<StageConfig> {
    return requireStageConfig();
}

// ─── Batch Deploy ────────────────────────────────────────────────────────────
// CloudFormation owns the stable infra (job queue, ECR repos, IAM roles, log
// groups, EventBridge rules that target job definitions BY NAME). This tool owns
// the deployment artifact: a new job-definition revision per commit. Because
// EventBridge / submit-job resolve a name → latest ACTIVE revision, registering
// a new revision is automatically what the next scheduled run uses — no infra
// mutation. This is the Fargate model with a job-def revision standing in for an
// ECS task-def revision.

interface ResolvedBatchConfig {
    jobQueue: string;
    executionRole?: string;
    jobs: BatchJobConfig[];   // image/jobRole/executionRole resolved to concrete values
}

async function resolveBatchConfig(): Promise<ResolvedBatchConfig> {
    await init();
    const batchConfig: BatchConfig | undefined = await getConfig('batch');
    if (!batchConfig) {
        throw new Error("'batch' configuration is required when computeMode is 'batch'");
    }
    const jobQueue = (await resolveVariable(batchConfig.jobQueue)) || batchConfig.jobQueue;
    const defaultExecutionRole = batchConfig.executionRole
        ? (await resolveVariable(batchConfig.executionRole)) || batchConfig.executionRole
        : undefined;

    const jobs: BatchJobConfig[] = [];
    for (const job of batchConfig.jobs) {
        const image = (await resolveVariable(job.image)) || job.image;
        const jobRole = job.jobRole ? (await resolveVariable(job.jobRole)) || job.jobRole : undefined;
        const executionRole = job.executionRole
            ? (await resolveVariable(job.executionRole)) || job.executionRole
            : defaultExecutionRole;
        jobs.push({ ...job, image, jobRole, executionRole });
    }
    return { jobQueue, executionRole: defaultExecutionRole, jobs };
}

// Registered job-definition name for a job in a stage. EventBridge rules in
// CloudFormation must reference this exact name so new revisions are picked up.
function batchJobDefinitionName(app: string, stage: string, jobName: string): string {
    return `${app}-${stage}-${jobName}`;
}

async function processBatchDeploy(stage: string, commit: string, dryRun: boolean = false, jobFilter?: string): Promise<BatchDeployResult> {
    await init();

    const app: string = await getConfig('app');
    const repo: string | undefined = await getConfig('repo');
    const batchConfig = await resolveBatchConfig();

    // Optional --job=a,b scope: deploy only the named jobs (e.g. when only the
    // reminders image was rebuilt for this commit). The preflight then verifies
    // exactly the selected jobs — nothing is registered for a job whose image
    // wasn't pushed at this commit.
    let jobs = batchConfig.jobs;
    if (jobFilter) {
        const wanted = jobFilter.split(',').map(s => s.trim()).filter(Boolean);
        const known = new Set(batchConfig.jobs.map(j => j.name));
        const unknown = wanted.filter(w => !known.has(w));
        if (unknown.length) {
            throw new Error(`--job names not found in cicd.json batch.jobs: ${unknown.join(', ')} (known: ${[...known].join(', ')})`);
        }
        const wantedSet = new Set(wanted);
        jobs = batchConfig.jobs.filter(j => wantedSet.has(j.name));
    }

    // ── Phase 1: ECR preflight ───────────────────────────────────────────────
    // CI owns the image push; the CLI must never *guess* that an image is there.
    // Inspect the actual ECR state of each job's repo and require an exact match
    // for {repo}:{commit}. Verify EVERY job before registering ANY, so a single
    // missing image can't leave a partial set of job definitions pointing at this
    // commit. One DescribeImages sweep per unique repo (reminders jobs share one).
    const tagCache = new Map<string, Set<string>>();
    async function tagsFor(repositoryName: string): Promise<Set<string>> {
        if (!tagCache.has(repositoryName)) {
            const tags = await ecr.listImageTags(repositoryName);
            logger.verbose(`   - ECR ${repositoryName}: ${tags.size} tag(s) present`);
            tagCache.set(repositoryName, tags);
        }
        return tagCache.get(repositoryName)!;
    }

    const missing: { job: string; repositoryName: string }[] = [];
    for (const job of jobs) {
        const repositoryName = ecr.parseRepositoryName(job.image);
        const tags = await tagsFor(repositoryName);
        if (!tags.has(commit)) {
            missing.push({ job: job.name, repositoryName });
        }
    }

    if (missing.length > 0) {
        const lines: string[] = [];
        for (const m of missing) {
            const recent = await ecr.recentImageTags(m.repositoryName);
            const avail = recent.length ? recent.join(', ') : '(no tagged images)';
            lines.push(`  - ${m.job}: ${m.repositoryName}:${commit} not found. Recent tags: ${avail}`);
        }
        throw new Error(
            `ECR preflight failed — no image tagged '${commit}' for ${missing.length} job(s). ` +
            `Push the commit-tagged image (CI build) before deploying:\n${lines.join('\n')}`
        );
    }

    // ── Phase 2: register job-definition revisions ───────────────────────────
    // Base env: global + stage variables (already resolved into envCache by init()).
    const baseEnv: Record<string, string> = {};
    if (state.envCache) {
        for (const [k, v] of state.envCache) baseEnv[k] = v;
    }

    const results: BatchJobDeployResult[] = [];
    for (const job of jobs) {
        const image = `${job.image}:${commit}`;
        const jobDefName = batchJobDefinitionName(app, stage, job.name);

        // Job-specific env merged over base env (job values support special prefixes).
        const env: Record<string, string> = { ...baseEnv };
        if (job.environment) {
            for (const [k, val] of Object.entries(job.environment)) {
                env[k] = await resolveVariable(val);
            }
        }
        env['COMMIT'] = commit;

        logger.verbose(`\n * Batch job '${jobDefName}':`);
        logger.verbose(`   - image: ${image}`);

        if (dryRun) {
            logger.verbose(`   - [dry run] would register ${jobDefName}`);
            results.push({ job: job.name, jobDefinitionName: jobDefName, jobDefinitionArn: '(dry-run)', revision: 0, image });
            continue;
        }

        const tags: Record<string, string> = { Commit: commit, App: app, Job: job.name };
        if (repo) tags['Repo'] = repo;

        const registered = await batch.registerJobDefinition({
            name: jobDefName,
            image,
            vcpu: job.vcpu,
            memory: job.memory,
            command: job.command,
            jobRoleArn: job.jobRole,
            executionRoleArn: job.executionRole,
            logGroup: job.logGroup,
            environment: env,
            tags
        });
        logger.verbose(`   - registered revision ${registered.revision}: ${registered.arn}`);
        results.push({
            job: job.name,
            jobDefinitionName: jobDefName,
            jobDefinitionArn: registered.arn,
            revision: registered.revision,
            image
        });
    }

    return { jobs: results };
}

// Rollback re-registers a new revision pointing at the prior commit's image.
// Submit / EventBridge resolve by name → latest revision, so this reverts the
// live job without touching any infra. Identical mechanics to deploy.
async function processBatchRollback(stage: string, commit: string, dryRun: boolean = false, jobFilter?: string): Promise<BatchDeployResult> {
    return processBatchDeploy(stage, commit, dryRun, jobFilter);
}

// Resolve every variable reference (global + each stage) and return a list of
// failures rather than throwing on the first one. Requires AWS credentials so
// CloudFormation exports and Parameter Store lookups can succeed.
async function validateAllVariables(): Promise<string[]> {
    const errors: string[] = [];

    try {
        if (!state.exportsInitialized) {
            await initExports();
            state.exportsInitialized = true;
        }
    } catch (e: any) {
        errors.push(e.message || String(e));
    }

    async function checkScope(env: Record<string, string> | undefined, scope: string): Promise<void> {
        if (!env) return;
        for (const key of Object.keys(env)) {
            try {
                await resolveVariable(env[key]);
            } catch (e: any) {
                errors.push(`${scope}.${key} = '${env[key]}'\n    ${e.message || e}`);
            }
        }
    }

    const globalEnv: Record<string, string> | undefined = await getConfig('environment');
    await checkScope(globalEnv, 'environment');

    const stages: StageConfig[] = (await getConfig('stages')) || [];
    for (const s of stages) {
        await checkScope(s.environment, `stages[${s.stage}].environment`);
    }

    return errors;
}

export {
    getLambdaExports,
    getExportByName,
    getExportsByType,
    getWorkers,
    getConfig,
    getVar,
    composeMappingPath,
    composeCloudFrontPath,
    decideMappingAction,
    findAliasExact,
    findVersion,
    validateRollbackTarget,
    buildKeepSet,
    commitFromAlias,
    unionKeep,
    processFunctionEnvironmentVars,
    processApiGateway,
    processSNS,
    processSQS,
    processWeb,
    processWebRollback,
    liveMarkerKey,
    processWorkers,
    processFargateDeploy,
    processFargateRestart,
    resolveFargateConfig,
    processBatchDeploy,
    processBatchRollback,
    resolveBatchConfig,
    batchJobDefinitionName,
    resolveVariable,
    setStageConfig,
    getCurrentStageConfig,
    resetForTest,
    validateAllVariables
};
