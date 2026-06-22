import {
    ECRClient,
    ListImagesCommand,
    BatchDeleteImageCommand,
    DescribeImagesCommand,
    ImageIdentifier
} from "@aws-sdk/client-ecr";

import * as awsContext from './aws-context';
import { awsRetry } from './utils';
import * as logger from './logger';

let client: ECRClient | null = null;

async function getClient(): Promise<ECRClient> {
    if (!client) {
        const region = await awsContext.getRegion();
        client = new ECRClient({ region });
    }
    return client;
}

function parseRepositoryName(ecrUri: string): string {
    const slashIndex = ecrUri.indexOf('/');
    if (slashIndex === -1) return ecrUri;
    return ecrUri.substring(slashIndex + 1);
}

async function listImages(repositoryName: string): Promise<ImageIdentifier[]> {
    const ecrClient = await getClient();
    const images: ImageIdentifier[] = [];
    let nextToken: string | undefined;
    do {
        const command = new ListImagesCommand({
            repositoryName,
            nextToken
        });
        const response = await awsRetry(() => ecrClient.send(command));
        if (response.imageIds) {
            images.push(...response.imageIds);
        }
        nextToken = response.nextToken;
    } while (nextToken);
    return images;
}

async function batchDeleteImages(repositoryName: string, imageIds: ImageIdentifier[]): Promise<{ deleted: number; failures: number }> {
    const ecrClient = await getClient();
    let deleted = 0;
    let failures = 0;

    // ECR limits BatchDeleteImage to 100 image IDs per call
    for (let i = 0; i < imageIds.length; i += 100) {
        const chunk = imageIds.slice(i, i + 100);
        const command = new BatchDeleteImageCommand({
            repositoryName,
            imageIds: chunk
        });
        const response = await awsRetry(() => ecrClient.send(command));
        deleted += response.imageIds?.length || 0;
        if (response.failures?.length) {
            failures += response.failures.length;
            for (const f of response.failures) {
                logger.verbose(`   - ECR delete failure: ${f.imageId?.imageTag || f.imageId?.imageDigest} - ${f.failureReason}`);
            }
        }
    }

    return { deleted, failures };
}

export interface ImageDetail {
    tags: string[];
    pushedAt?: Date;
    digest?: string;
}

// Enumerate the actual state of a repository — every image, its tags, and when it
// was pushed. The deploy preflight uses this to confirm a commit-tagged image
// really exists before registering a job definition (Batch accepts a missing
// image and only fails at run time), and to show what tags ARE present when the
// expected one is absent. Returns [] for an empty or not-yet-created repository.
async function listImageDetails(repositoryName: string): Promise<ImageDetail[]> {
    const ecrClient = await getClient();
    const details: ImageDetail[] = [];
    let nextToken: string | undefined;
    try {
        do {
            const command = new DescribeImagesCommand({ repositoryName, nextToken });
            const response = await awsRetry(() => ecrClient.send(command));
            for (const d of (response.imageDetails || [])) {
                details.push({
                    tags: d.imageTags || [],
                    pushedAt: d.imagePushedAt,
                    digest: d.imageDigest
                });
            }
            nextToken = response.nextToken;
        } while (nextToken);
    } catch (e: any) {
        // A repository that exists but has no images yet returns normally; only a
        // missing repository throws. Treat "no repo" as "no images" so the
        // preflight reports a clear, actionable error rather than an AWS stack.
        if (e.name === 'RepositoryNotFoundException') return [];
        throw e;
    }
    return details;
}

// All tags currently present in a repository.
async function listImageTags(repositoryName: string): Promise<Set<string>> {
    const details = await listImageDetails(repositoryName);
    const tags = new Set<string>();
    for (const d of details) for (const t of d.tags) tags.add(t);
    return tags;
}

// Newest-first tags from a set of image details (pure; exported for testing).
function selectRecentTags(details: ImageDetail[], limit: number = 10): string[] {
    return details
        .filter(d => d.tags.length > 0)
        .slice()
        .sort((a, b) => (b.pushedAt?.getTime() || 0) - (a.pushedAt?.getTime() || 0))
        .flatMap(d => d.tags)
        .slice(0, limit);
}

// Most-recently-pushed tags (newest first), for actionable error messages.
async function recentImageTags(repositoryName: string, limit: number = 10): Promise<string[]> {
    const details = await listImageDetails(repositoryName);
    return selectRecentTags(details, limit);
}

export { parseRepositoryName, listImages, batchDeleteImages, listImageDetails, listImageTags, recentImageTags, selectRecentTags };
