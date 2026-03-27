import {
    ECRClient,
    ListImagesCommand,
    BatchDeleteImageCommand,
    ImageIdentifier
} from "@aws-sdk/client-ecr";

import { getConfig } from './config';
import { awsRetry } from './utils';
import * as logger from './logger';

let client: ECRClient | null = null;

async function getClient(): Promise<ECRClient> {
    if (!client) {
        const region = await getConfig('region');
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

export { parseRepositoryName, listImages, batchDeleteImages };
