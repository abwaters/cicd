import { EnvResult, APIResult, SNSResult, SQSResult, WorkerResult, WebResult } from '../types';
import { PluginResult } from './plugin';

export interface DeploymentResults {
    env?: EnvResult[] | null;
    api?: APIResult | null;
    sns?: SNSResult | null;
    sqs?: SQSResult | null;
    workers?: WorkerResult | null;
    web?: WebResult | null;
    pluginResults?: PluginResult[];
}

/**
 * Prints detailed deployment/rollback results and returns a summary parts array.
 */
export function printDeploymentSummary(results: DeploymentResults): string[] {
    const { env, api, sns, sqs, workers, web, pluginResults } = results;

    // Environment Variables
    if (env && env.length > 0) {
        console.log(`\nEnvironment Variables:`);
        for (const r of env) {
            const status = r.updated ? `${r.varCount} vars` : 'skipped';
            console.log(`  ${r.name.padEnd(40)} ${status}`);
        }
    }

    // API Functions
    if (api && api.functions.length > 0) {
        console.log(`\nAPI Functions:`);
        for (const r of api.functions) {
            const versionLabel = r.version ? `v${r.version}` : '';
            console.log(`  ${r.name.padEnd(40)} ${r.action.padEnd(10)} ${versionLabel}`);
        }
    }

    // API Deployments
    if (api && api.apis.length > 0) {
        console.log(`\nAPI Deployments:`);
        for (const r of api.apis) {
            console.log(`  ${r.name.padEnd(40)} deployment ${r.deployment.padEnd(10)} stage ${r.stage.padEnd(10)} mapping ${r.mapping}`);
        }
    }

    // SNS Functions
    if (sns && sns.functions.length > 0) {
        console.log(`\nSNS Functions:`);
        for (const r of sns.functions) {
            const versionLabel = r.version ? `v${r.version}` : '';
            console.log(`  ${r.name.padEnd(40)} ${r.action.padEnd(10)} ${versionLabel}`);
        }
    }

    // SNS Subscriptions
    if (sns && sns.subscriptions.length > 0) {
        console.log(`\nSNS Subscriptions:`);
        for (const r of sns.subscriptions) {
            if (r.action === 'skipped') {
                console.log(`  ${r.name.padEnd(40)} skipped`);
            } else {
                const oldLabel = r.oldRemoved && r.oldRemoved > 0 ? `  ${r.oldRemoved} old removed` : '';
                console.log(`  ${r.name.padEnd(40)} subscribed${oldLabel}`);
            }
        }
    }

    // SQS Functions
    if (sqs && sqs.functions.length > 0) {
        console.log(`\nSQS Functions:`);
        for (const r of sqs.functions) {
            const versionLabel = r.version ? `v${r.version}` : '';
            console.log(`  ${r.name.padEnd(40)} ${r.action.padEnd(10)} ${versionLabel}`);
        }
    }

    // SQS Event Source Mappings
    if (sqs && sqs.eventSources.length > 0) {
        console.log(`\nSQS Event Sources:`);
        for (const r of sqs.eventSources) {
            if (r.action === 'skipped') {
                console.log(`  ${r.name.padEnd(40)} skipped`);
            } else {
                const oldLabel = r.oldRemoved && r.oldRemoved > 0 ? `  ${r.oldRemoved} old removed` : '';
                console.log(`  ${r.name.padEnd(40)} ${r.action}${oldLabel}`);
            }
        }
    }

    // Workers
    if (workers && workers.functions.length > 0) {
        console.log(`\nWorkers:`);
        for (const r of workers.functions) {
            const versionLabel = r.version ? `v${r.version}` : '';
            const commitLabel = r.commit ? `${r.commit}` : '';
            console.log(`  ${r.name.padEnd(40)} ${r.action.padEnd(10)} ${versionLabel.padEnd(8)} ${commitLabel}`);
        }
    }

    // Web (S3 + CloudFront)
    if (web && web.exports.length > 0) {
        console.log(`\nWeb:`);
        for (const r of web.exports) {
            const noindex = r.noindexInjected ? ' [noindex]' : '';
            const inv = r.invalidationId ? `inv ${r.invalidationId}` : '';
            console.log(`  ${r.name.padEnd(30)} ${r.bucket.padEnd(30)} ${r.originPath.padEnd(20)} ${r.fileCount} files, ${r.totalBytes} bytes${noindex} ${inv}`);
        }
    }

    // Plugin results (each plugin owns its own rendering)
    if (pluginResults && pluginResults.length > 0) {
        for (const r of pluginResults) {
            for (const line of r.summaryLines) {
                console.log(line);
            }
        }
    }

    // Build summary parts
    const parts: string[] = [];
    if (env) {
        const updated = env.filter(r => r.updated).length;
        parts.push(`${updated} functions configured`);
    }
    if (api) {
        const created = api.functions.filter(r => r.action === 'created').length;
        const existing = api.functions.filter(r => r.action === 'exists').length;
        parts.push(`${api.apis.length} APIs deployed (${created} new, ${existing} existing)`);
    }
    if (sns) {
        const subscribed = sns.subscriptions.filter(r => r.action === 'subscribed').length;
        const skipped = sns.subscriptions.filter(r => r.action === 'skipped').length;
        if (subscribed > 0 || skipped > 0) {
            parts.push(`${subscribed} topics subscribed${skipped > 0 ? `, ${skipped} skipped` : ''}`);
        }
    }
    if (sqs) {
        const created = sqs.eventSources.filter(r => r.action === 'created').length;
        const updated = sqs.eventSources.filter(r => r.action === 'updated').length;
        const exists = sqs.eventSources.filter(r => r.action === 'exists').length;
        const skipped = sqs.eventSources.filter(r => r.action === 'skipped').length;
        if (created + updated + exists + skipped > 0) {
            const segs: string[] = [];
            if (created > 0) segs.push(`${created} created`);
            if (updated > 0) segs.push(`${updated} updated`);
            if (exists > 0) segs.push(`${exists} existing`);
            if (skipped > 0) segs.push(`${skipped} skipped`);
            parts.push(`SQS: ${segs.join(', ')}`);
        }
    }
    if (workers) {
        const created = workers.functions.filter(r => r.action === 'created').length;
        const updated = workers.functions.filter(r => r.action === 'updated').length;
        const exists = workers.functions.filter(r => r.action === 'exists').length;
        const skipped = workers.functions.filter(r => r.action === 'skipped').length;
        if (created + updated + exists + skipped > 0) {
            const segs: string[] = [];
            if (created > 0) segs.push(`${created} new`);
            if (updated > 0) segs.push(`${updated} updated`);
            if (exists > 0) segs.push(`${exists} existing`);
            if (skipped > 0) segs.push(`${skipped} skipped`);
            parts.push(`Workers: ${segs.join(', ')}`);
        }
    }
    if (web && web.exports.length > 0) {
        const totalFiles = web.exports.reduce((acc, r) => acc + r.fileCount, 0);
        parts.push(`${web.exports.length} web export(s) deployed (${totalFiles} files)`);
    }
    if (pluginResults) {
        for (const r of pluginResults) {
            parts.push(...r.summaryParts);
        }
    }

    return parts;
}
