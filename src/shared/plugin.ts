import { StageConfig, ExportConfig } from '../types';

export type PluginPhase = 'deploy' | 'rollback' | 'info';

export interface PluginContext {
    stage: string;
    stageConfig: Readonly<StageConfig>;
    pluginConfig: unknown;
    dryRun: boolean;
    env: NodeJS.ProcessEnv;
    resolveVariable(s: string): Promise<string>;
    composeMappingPath(api: ExportConfig): string;
    getExport(name: string): Promise<ExportConfig | null>;
    getExportsByType(type: string): Promise<ExportConfig[]>;
    logger: { log(m: string): void; verbose(m: string): void };
}

export interface PluginInfoContext {
    stages: ReadonlyArray<StageConfig>;
    env: NodeJS.ProcessEnv;
    resolveVariable(s: string): Promise<string>;
    getExport(name: string): Promise<ExportConfig | null>;
    getExportsByType(type: string): Promise<ExportConfig[]>;
    logger: { log(m: string): void; verbose(m: string): void };
}

export interface PluginResult {
    summaryLines: string[];
    summaryParts: string[];
    raw?: unknown;
}

export interface CICDPlugin {
    name: string;
    configKey?: string;
    scopeFlag?: string;
    stageSchema?: object;
    deploy?(ctx: PluginContext): Promise<PluginResult | null>;
    rollback?(ctx: PluginContext): Promise<PluginResult | null>;
    info?(ctx: PluginInfoContext): Promise<PluginResult | null>;
}

export function pluginConfigKey(p: CICDPlugin): string {
    return p.configKey || p.name;
}

export function pluginScopeFlag(p: CICDPlugin): string {
    if (p.scopeFlag) return p.scopeFlag;
    return 'no' + p.name.charAt(0).toUpperCase() + p.name.slice(1);
}
