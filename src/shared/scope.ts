import { CLIOptions } from '../types';

export interface DeployScope {
    processEnv: boolean;
    processApi: boolean;
    processSns: boolean;
    processSqs: boolean;
    processWorkers: boolean;
    processTwilio: boolean;
    processWeb: boolean;
    apiFilter: string;
    webFilter: string;
}

export function resolveScope(o: CLIOptions): DeployScope {
    let processEnv = false;
    let processApi = true;
    let processSns = true;
    let processSqs = true;
    let processWorkers = true;
    let processTwilio = true;
    let processWeb = true;

    if (o.env) {
        processEnv = true;
        processApi = false;
        processSns = false;
        processSqs = false;
        processWorkers = false;
        processTwilio = false;
        processWeb = false;
    } else if (o.api || o.sns || o.sqs || o.workers || o.web) {
        processApi = !!o.api;
        processSns = !!o.sns;
        processSqs = !!o.sqs;
        processWorkers = !!o.workers;
        processWeb = !!o.web;
        processTwilio = false;
    }

    if (o.noTwilio) {
        processTwilio = false;
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

    return { processEnv, processApi, processSns, processSqs, processWorkers, processTwilio, processWeb, apiFilter, webFilter };
}

export function scopeLabel(scope: DeployScope): string {
    const parts: string[] = [];
    if (scope.processEnv && !scope.processApi && !scope.processSns && !scope.processSqs && !scope.processWorkers && !scope.processWeb) {
        parts.push('Environment only');
    } else {
        if (scope.processApi) parts.push(scope.apiFilter ? `API (${scope.apiFilter})` : 'API');
        if (scope.processSns) parts.push('SNS');
        if (scope.processSqs) parts.push('SQS');
        if (scope.processWorkers) parts.push('Workers');
        if (scope.processWeb) parts.push(scope.webFilter ? `Web (${scope.webFilter})` : 'Web');
        if (scope.processTwilio) parts.push('Twilio');
        if (parts.length === 0) parts.push('Environment only');
        else parts.unshift('Environment');
    }
    return parts.join(' + ');
}
