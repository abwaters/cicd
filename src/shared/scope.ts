import { CLIOptions } from '../types';
import { CICDPlugin, pluginScopeFlag } from './plugin';

export interface DeployScope {
    processEnv: boolean;
    processApi: boolean;
    processSns: boolean;
    processSqs: boolean;
    processWorkers: boolean;
    processWeb: boolean;
    apiFilter: string;
    webFilter: string;
    disabledPlugins: Set<string>;
    enabledPluginNames: string[];
}

export function resolveScope(o: CLIOptions, plugins: CICDPlugin[] = []): DeployScope {
    let processEnv = false;
    let processApi = true;
    let processSns = true;
    let processSqs = true;
    let processWorkers = true;
    let processWeb = true;

    let pluginsAutoDisabled = false;

    if (o.env) {
        processEnv = true;
        processApi = false;
        processSns = false;
        processSqs = false;
        processWorkers = false;
        processWeb = false;
        pluginsAutoDisabled = true;
    } else if (o.api || o.sns || o.sqs || o.workers || o.web) {
        processApi = !!o.api;
        processSns = !!o.sns;
        processSqs = !!o.sqs;
        processWorkers = !!o.workers;
        processWeb = !!o.web;
        pluginsAutoDisabled = true;
    }

    const disabledPlugins = new Set<string>();
    const enabledPluginNames: string[] = [];
    for (const p of plugins) {
        const flag = pluginScopeFlag(p);
        if (pluginsAutoDisabled || o[flag]) {
            disabledPlugins.add(p.name);
        } else {
            enabledPluginNames.push(p.name);
        }
    }

    if (processApi || processSns || processSqs || processWorkers) {
        processEnv = true;
    }

    let apiFilter = '';
    if (o.apiFilter) {
        apiFilter = o.apiFilter as string;
    }

    let webFilter = '';
    if (o.webFilter) {
        webFilter = o.webFilter as string;
    }

    return {
        processEnv, processApi, processSns, processSqs, processWorkers, processWeb,
        apiFilter, webFilter,
        disabledPlugins, enabledPluginNames,
    };
}

// Short bracket-label for the deploy header, e.g. [web], [api+web], [fargate].
// Reflects what this invocation will actually touch: the resource kinds that
// are both configured and in scope. Falls back to 'env' for an env-only deploy
// and 'lambda' when nothing is configured.
export function deployTargetLabel(
    scope: DeployScope,
    opts: { computeMode: string; exportTypes: string[]; hasWorkers: boolean }
): string {
    if (opts.computeMode === 'fargate') return 'fargate';
    const present = new Set(opts.exportTypes);
    const kinds: string[] = [];
    if (scope.processApi && present.has('api')) kinds.push('api');
    if (scope.processSns && present.has('sns')) kinds.push('sns');
    if (scope.processSqs && present.has('sqs')) kinds.push('sqs');
    if (scope.processWorkers && opts.hasWorkers) kinds.push('workers');
    if (scope.processWeb && present.has('web')) kinds.push('web');
    if (kinds.length) return kinds.join('+');
    if (scope.processEnv) return 'env';
    return 'lambda';
}

export function scopeLabel(scope: DeployScope): string {
    const parts: string[] = [];
    if (scope.processEnv && !scope.processApi && !scope.processSns && !scope.processSqs && !scope.processWorkers && !scope.processWeb && scope.enabledPluginNames.length === 0) {
        parts.push('Environment only');
    } else {
        if (scope.processApi) parts.push(scope.apiFilter ? `API (${scope.apiFilter})` : 'API');
        if (scope.processSns) parts.push('SNS');
        if (scope.processSqs) parts.push('SQS');
        if (scope.processWorkers) parts.push('Workers');
        if (scope.processWeb) parts.push(scope.webFilter ? `Web (${scope.webFilter})` : 'Web');
        for (const name of scope.enabledPluginNames) {
            parts.push(name.charAt(0).toUpperCase() + name.slice(1));
        }
        if (parts.length === 0) parts.push('Environment only');
        else parts.unshift('Environment');
    }
    return parts.join(' + ');
}
