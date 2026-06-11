import { StageConfig } from '../types';
import {
    CICDPlugin,
    PluginContext,
    PluginInfoContext,
    PluginResult,
    PluginPhase,
    pluginConfigKey,
} from './plugin';
import { getPlugins } from './plugins';
import * as cicd from './cicd';
import * as logger from './logger';

function makeLogger() {
    return {
        log: (m: string) => logger.log(m),
        verbose: (m: string) => logger.verbose(m),
    };
}

function buildContext(plugin: CICDPlugin, stage: string, stageConfig: StageConfig, dryRun: boolean): PluginContext {
    return {
        stage,
        stageConfig,
        pluginConfig: (stageConfig as any)[pluginConfigKey(plugin)],
        dryRun,
        env: process.env,
        resolveVariable: (s: string) => cicd.resolveVariable(s),
        composeMappingPath: (api) => cicd.composeMappingPath(stageConfig, api),
        getExport: (name: string) => cicd.getExportByName(name),
        getExportsByType: (type: string) => cicd.getExportsByType(type),
        logger: makeLogger(),
    };
}

function buildInfoContext(stages: ReadonlyArray<StageConfig>): PluginInfoContext {
    return {
        stages,
        env: process.env,
        resolveVariable: (s: string) => cicd.resolveVariable(s),
        getExport: (name: string) => cicd.getExportByName(name),
        getExportsByType: (type: string) => cicd.getExportsByType(type),
        logger: makeLogger(),
    };
}

export async function runPlugins(
    phase: 'deploy' | 'rollback',
    stage: string,
    stageConfig: StageConfig,
    dryRun: boolean,
    disabledPlugins: Set<string>,
): Promise<PluginResult[]> {
    const plugins = getPlugins();
    const results: PluginResult[] = [];
    for (const plugin of plugins) {
        if (disabledPlugins.has(plugin.name)) continue;
        const handler = phase === 'deploy' ? plugin.deploy : plugin.rollback;
        if (!handler) continue;
        const ctx = buildContext(plugin, stage, stageConfig, dryRun);
        if (ctx.pluginConfig === undefined) continue;
        try {
            const r = await handler.call(plugin, ctx);
            if (r) results.push(r);
        } catch (e: any) {
            throw new Error(`[plugin:${plugin.name}] ${e.message || e}`, { cause: e });
        }
    }
    return results;
}

export async function runInfoPlugins(stages: ReadonlyArray<StageConfig>): Promise<PluginResult[]> {
    const plugins = getPlugins();
    const results: PluginResult[] = [];
    const ctx = buildInfoContext(stages);
    for (const plugin of plugins) {
        if (!plugin.info) continue;
        try {
            const r = await plugin.info.call(plugin, ctx);
            if (r) results.push(r);
        } catch (e: any) {
            throw new Error(`[plugin:${plugin.name}] ${e.message || e}`, { cause: e });
        }
    }
    return results;
}

export type { PluginPhase };
