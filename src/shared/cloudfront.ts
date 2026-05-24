import {
    CloudFrontClient,
    GetDistributionConfigCommand,
    UpdateDistributionCommand,
    CreateInvalidationCommand,
    DistributionConfig
} from "@aws-sdk/client-cloudfront";

import * as awsContext from './aws-context';
import { awsRetry } from './utils';

let client: CloudFrontClient | null = null;

async function getClient(): Promise<CloudFrontClient> {
    if (!client) {
        // CloudFront is a global service; SDK requires a region but ignores it for control-plane calls.
        const region = await awsContext.getRegion();
        client = new CloudFrontClient({ region });
    }
    return client;
}

interface DistributionConfigResult {
    eTag: string;
    config: DistributionConfig;
}

async function getDistributionConfig(distributionId: string): Promise<DistributionConfigResult> {
    const cf = await getClient();
    const resp = await awsRetry(() => cf.send(new GetDistributionConfigCommand({ Id: distributionId })));
    if (!resp.ETag || !resp.DistributionConfig) {
        throw new Error(`getDistributionConfig: missing ETag or DistributionConfig for '${distributionId}'`);
    }
    return { eTag: resp.ETag, config: resp.DistributionConfig };
}

async function updateOriginPath(
    distributionId: string,
    originId: string,
    originPath: string
): Promise<void> {
    const cf = await getClient();
    const { eTag, config } = await getDistributionConfig(distributionId);

    const origins = config.Origins?.Items ?? [];
    const target = origins.find(o => o.Id === originId);
    if (!target) {
        const ids = origins.map(o => o.Id).join(', ') || '(none)';
        throw new Error(
            `updateOriginPath: distribution '${distributionId}' has no origin with id '${originId}' (origins: ${ids})`
        );
    }

    if (target.OriginPath === originPath) {
        // No-op: already on the requested path.
        return;
    }
    target.OriginPath = originPath;

    await awsRetry(() => cf.send(new UpdateDistributionCommand({
        Id: distributionId,
        IfMatch: eTag,
        DistributionConfig: config
    })));
}

async function getOriginPath(distributionId: string, originId: string): Promise<string | null> {
    const { config } = await getDistributionConfig(distributionId);
    const origins = config.Origins?.Items ?? [];
    const target = origins.find(o => o.Id === originId);
    if (!target) return null;
    return target.OriginPath ?? '';
}

async function createInvalidation(distributionId: string, paths: string[]): Promise<string> {
    const cf = await getClient();
    const resp = await awsRetry(() => cf.send(new CreateInvalidationCommand({
        DistributionId: distributionId,
        InvalidationBatch: {
            CallerReference: `cicd-${Date.now()}`,
            Paths: { Quantity: paths.length, Items: paths }
        }
    })));
    if (!resp.Invalidation?.Id) {
        throw new Error(`createInvalidation: missing invalidation id in response for '${distributionId}'`);
    }
    return resp.Invalidation.Id;
}

export {
    getDistributionConfig,
    updateOriginPath,
    getOriginPath,
    createInvalidation
};
