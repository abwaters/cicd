import { CLIOptions } from '../types';

export interface DeployScope {
    processEnv: boolean;
    processApi: boolean;
    processSns: boolean;
    processTwilio: boolean;
    apiFilter: string;
}

export function resolveScope(o: CLIOptions): DeployScope {
    let processEnv = false;
    let processApi = true;
    let processSns = true;
    let processTwilio = true;

    if (o.env) {
        processEnv = true;
        processApi = false;
        processSns = false;
        processTwilio = false;
    } else if (o.api || o.sns) {
        processApi = processSns = false;
        processApi = !!o.api;
        processSns = !!o.sns;
        processTwilio = false;
    }

    if (o.noTwilio) {
        processTwilio = false;
    }

    if (processApi || processSns) {
        processEnv = true;
    }

    let apiFilter = '';
    if (o.apiFilter) {
        apiFilter = o.apiFilter as string;
    }

    return { processEnv, processApi, processSns, processTwilio, apiFilter };
}

export function scopeLabel(scope: DeployScope): string {
    const parts: string[] = [];
    if (scope.processEnv && !scope.processApi && !scope.processSns) {
        parts.push('Environment only');
    } else {
        if (scope.processApi) parts.push(scope.apiFilter ? `API (${scope.apiFilter})` : 'API');
        if (scope.processSns) parts.push('SNS');
        if (scope.processTwilio) parts.push('Twilio');
        if (parts.length === 0) parts.push('Environment only');
        else parts.unshift('Environment');
    }
    return parts.join(' + ');
}
