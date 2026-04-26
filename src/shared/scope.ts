import { CLIOptions } from '../types';

export interface DeployScope {
    processEnv: boolean;
    processApi: boolean;
    processSns: boolean;
    processSqs: boolean;
    processTwilio: boolean;
    apiFilter: string;
}

export function resolveScope(o: CLIOptions): DeployScope {
    let processEnv = false;
    let processApi = true;
    let processSns = true;
    let processSqs = true;
    let processTwilio = true;

    if (o.env) {
        processEnv = true;
        processApi = false;
        processSns = false;
        processSqs = false;
        processTwilio = false;
    } else if (o.api || o.sns || o.sqs) {
        processApi = !!o.api;
        processSns = !!o.sns;
        processSqs = !!o.sqs;
        processTwilio = false;
    }

    if (o.noTwilio) {
        processTwilio = false;
    }

    if (processApi || processSns || processSqs) {
        processEnv = true;
    }

    let apiFilter = '';
    if (o.apiFilter) {
        apiFilter = o.apiFilter as string;
    }

    return { processEnv, processApi, processSns, processSqs, processTwilio, apiFilter };
}

export function scopeLabel(scope: DeployScope): string {
    const parts: string[] = [];
    if (scope.processEnv && !scope.processApi && !scope.processSns && !scope.processSqs) {
        parts.push('Environment only');
    } else {
        if (scope.processApi) parts.push(scope.apiFilter ? `API (${scope.apiFilter})` : 'API');
        if (scope.processSns) parts.push('SNS');
        if (scope.processSqs) parts.push('SQS');
        if (scope.processTwilio) parts.push('Twilio');
        if (parts.length === 0) parts.push('Environment only');
        else parts.unshift('Environment');
    }
    return parts.join(' + ');
}
