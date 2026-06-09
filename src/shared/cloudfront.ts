import {
    CloudFrontClient,
    GetDistributionConfigCommand,
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

async function getOriginPath(distributionId: string, originId: string): Promise<string | null> {
    const { config } = await getDistributionConfig(distributionId);
    const origins = config.Origins?.Items ?? [];
    const target = origins.find(o => o.Id === originId);
    if (!target) return null;
    return target.OriginPath ?? '';
}

interface CacheBehaviorInfo {
    targetOriginId: string;
    cachePolicyId?: string;
    originPath: string | null;  // OriginPath of the target origin, null if origin not found
}

// Read-only: find an ordered cache behavior by exact path pattern and resolve
// its target origin's OriginPath. Used by the deploy drift-check to confirm a
// distribution is wired up for a CloudFront-mapped API stage. Returns null when
// no behavior matches the pattern.
async function getCacheBehavior(distributionId: string, pathPattern: string): Promise<CacheBehaviorInfo | null> {
    const { config } = await getDistributionConfig(distributionId);
    const behaviors = config.CacheBehaviors?.Items ?? [];
    const behavior = behaviors.find(b => b.PathPattern === pathPattern);
    if (!behavior || !behavior.TargetOriginId) return null;
    const origins = config.Origins?.Items ?? [];
    const origin = origins.find(o => o.Id === behavior.TargetOriginId);
    return {
        targetOriginId: behavior.TargetOriginId,
        cachePolicyId: behavior.CachePolicyId,
        originPath: origin ? (origin.OriginPath ?? '') : null
    };
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
    getOriginPath,
    getCacheBehavior,
    createInvalidation
};
