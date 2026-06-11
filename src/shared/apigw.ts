import {
    APIGatewayClient,
    DeleteBasePathMappingCommand,
    DeleteDeploymentCommand,
    GetDeploymentsCommand,
    UpdateStageCommand,
    GetStagesCommand,
    CreateDeploymentCommand,
    CreateStageCommand,
    CreateBasePathMappingCommand,
    GetBasePathMappingsCommand,
    TagResourceCommand,
    Deployment,
    Stage,
    BasePathMapping,
    PatchOperation
} from "@aws-sdk/client-api-gateway";
import {
    ApiGatewayV2Client,
    CreateApiMappingCommand,
    GetApiMappingsCommand,
    ApiMapping
} from "@aws-sdk/client-apigatewayv2";
import { ThrottleSettings, DeploymentInfo } from '../types';

import * as config from './config';
import * as awsContext from './aws-context';
import { awsRetry } from './utils';

let client: APIGatewayClient | null = null;
let clientv2: ApiGatewayV2Client | null = null;

async function getClient(): Promise<APIGatewayClient> {
    if (!client) {
        const region = await awsContext.getRegion();
        client = new APIGatewayClient({ region });
    }
    return client;
}

async function getClientV2(): Promise<ApiGatewayV2Client> {
    if (!clientv2) {
        const region = await awsContext.getRegion();
        clientv2 = new ApiGatewayV2Client({ region });
    }
    return clientv2;
}

async function createDeployment(apiId: string, commit: string): Promise<DeploymentInfo> {
    const command = new CreateDeploymentCommand({
        restApiId: apiId,
        description: commit
    });
    const apiClient = await getClient();
    const response = await awsRetry(() => apiClient.send(command));
    return {id: response.id!, description: response.description};
}

async function createStage(apiId: string, stageName: string, deploymentId: string, commit: string, throttleSettings: ThrottleSettings | null): Promise<void> {
    const app = await config.getConfig('app');
    const commandParams: any = {
        restApiId: apiId,
        stageName: stageName,
        deploymentId: deploymentId,
        description: commit,
        variables: {"Commit": commit},
        tags: {
            Customer: app,
            Name: app,
            Commit: commit
        }
    };

    // Add throttle settings if provided
    if (throttleSettings && (throttleSettings.rateLimit !== undefined || throttleSettings.burstLimit !== undefined)) {
        commandParams.throttleSettings = {
            rateLimit: throttleSettings.rateLimit,
            burstLimit: throttleSettings.burstLimit
        };
    }

    const command = new CreateStageCommand(commandParams);
    const apiClient = await getClient();
    await awsRetry(() => apiClient.send(command));
}

async function createCustomDomainMapping(domainName: string, restApiId: string, stage: string, basePath: string): Promise<void> {
    const command = new CreateBasePathMappingCommand({
        domainName: domainName,
        restApiId: restApiId,
        stage: stage,
        basePath: basePath
    });
    const apiClient = await getClient();
    await awsRetry(() => apiClient.send(command));
}

async function listDeployments(restApiId: string): Promise<Deployment[]> {
    const apiClient = await getClient();
    const deployments: Deployment[] = [];
    let position: string | undefined = undefined;
    do {
        const command: GetDeploymentsCommand = new GetDeploymentsCommand({
            restApiId: restApiId,
            position: position
        });
        const response = await awsRetry(() => apiClient.send(command));
        deployments.push(...(response.items || []));
        position = response.position;
    } while (position);
    return deployments;
}

async function listStages(restApiId: string): Promise<Stage[]> {
    // GetStages is not paginated: it always returns the full set of stages.
    const command = new GetStagesCommand({
        restApiId: restApiId
    });
    const apiClient = await getClient();
    const response = await awsRetry(() => apiClient.send(command));
    return response.item || [];
}

async function updateStage(restApiId: string, stageName: string, deploymentId: string, commit: string, throttleSettings: ThrottleSettings | null): Promise<void> {
    const app = await config.getConfig('app');
    const region = await awsContext.getRegion();
    const patchOperations: PatchOperation[] = [
        {
            op: "replace",
            path: "/deploymentId",
            value: deploymentId
        },
        {
            op: "replace",
            path: "/description",
            value: commit
        },
        {
            op: "replace",
            path: "/variables/Commit",
            value: commit
        }
    ];

    // Add throttle patch operations if provided
    if (throttleSettings) {
        if (throttleSettings.rateLimit !== undefined) {
            patchOperations.push({
                op: "replace",
                path: "/*/*/throttling/rateLimit",
                value: String(throttleSettings.rateLimit)
            });
        }
        if (throttleSettings.burstLimit !== undefined) {
            patchOperations.push({
                op: "replace",
                path: "/*/*/throttling/burstLimit",
                value: String(throttleSettings.burstLimit)
            });
        }
    }

    const command = new UpdateStageCommand({
        restApiId: restApiId,
        stageName: stageName,
        patchOperations: patchOperations
    });

    const apiClient = await getClient();
    await awsRetry(() => apiClient.send(command));

    // Update tags on existing stage; tags are informational, so a tagging
    // failure should not fail the deployment of the stage itself.
    try {
        const stageArn = `arn:aws:apigateway:${region}::/restapis/${restApiId}/stages/${stageName}`;
        const tagCommand = new TagResourceCommand({
            resourceArn: stageArn,
            tags: {
                Customer: app,
                Name: app,
                Commit: commit
            }
        });
        await awsRetry(() => apiClient.send(tagCommand));
    } catch (tagError) {
        console.error("Error tagging stage:", tagError);
    }
}

async function deleteBasePathMapping(domainName: string, basePath: string): Promise<void> {
    try {
        const command = new DeleteBasePathMappingCommand({
            domainName: domainName,
            basePath: basePath === '' ? '(none)' : basePath
        });
        const apiClient = await getClient();
        await awsRetry(() => apiClient.send(command));
    } catch (error) {
        console.error(`Error deleting base path mapping '${basePath}' on domain ${domainName}:`, error);
        throw error;
    }
}

async function listBasePathMappings(domainName: string): Promise<BasePathMapping[]> {
    const apiClient = await getClient();
    const mappings: BasePathMapping[] = [];
    let position: string | undefined = undefined;
    do {
        const command: GetBasePathMappingsCommand = new GetBasePathMappingsCommand({
            domainName: domainName,
            position: position
        });
        const response = await awsRetry(() => apiClient.send(command));
        mappings.push(...(response.items || []));
        position = response.position;
    } while (position);
    return mappings;
}

async function createCustomDomainMappingV2(domainName: string, apiId: string, stage: string, basePath: string): Promise<void> {
    const command = new CreateApiMappingCommand({
        DomainName: domainName,
        ApiId: apiId,
        Stage: stage,
        ApiMappingKey: basePath
    });
    const apiClientV2 = await getClientV2();
    await awsRetry(() => apiClientV2.send(command));
}

async function listApiMappingsV2(domainName: string): Promise<ApiMapping[]> {
    const apiClientV2 = await getClientV2();
    const mappings: ApiMapping[] = [];
    let nextToken: string | undefined = undefined;
    do {
        const command: GetApiMappingsCommand = new GetApiMappingsCommand({
            DomainName: domainName,
            NextToken: nextToken
        });
        const response = await awsRetry(() => apiClientV2.send(command));
        mappings.push(...(response.Items || []));
        nextToken = response.NextToken;
    } while (nextToken);
    return mappings;
}

async function deleteDeployment(apiId: string, deploymentId: string): Promise<void> {
    const command = new DeleteDeploymentCommand({
        restApiId: apiId,
        deploymentId: deploymentId
    });

    try {
        const apiClient = await getClient();
        await awsRetry(() => apiClient.send(command));
    } catch (error) {
        console.error("Error deleting deployment:", error);
    }
}

export { createDeployment, createStage, deleteDeployment, createCustomDomainMapping, createCustomDomainMappingV2, listApiMappingsV2, listDeployments, listStages, updateStage, listBasePathMappings, deleteBasePathMapping };
