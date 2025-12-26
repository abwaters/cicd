const {
    APIGatewayClient,
    GetDomainNamesCommand,
    DeleteDeploymentCommand,
    GetDeploymentsCommand,
    UpdateStageCommand,
    GetStagesCommand,
    CreateDeploymentCommand,
    CreateStageCommand,
    CreateBasePathMappingCommand,
    GetBasePathMappingsCommand,
    TagResourceCommand } = require("@aws-sdk/client-api-gateway");
const {
    ApiGatewayV2Client,
    CreateApiMappingCommand } = require("@aws-sdk/client-apigatewayv2");
const config = require('./config');
const utils = require('./utils');

let client = null;
let clientv2 = null;

async function getClient() {
    if (!client) {
        const region = await config.getConfig('region');
        client = new APIGatewayClient({ region });
    }
    return client;
}

async function getClientV2() {
    if (!clientv2) {
        const region = await config.getConfig('region');
        clientv2 = new ApiGatewayV2Client({ region });
    }
    return clientv2;
}

async function createDeployment(apiId,commit) {
    try {
        // Create the command with the necessary parameters
        const command = new CreateDeploymentCommand({
            restApiId: apiId,
            description: commit
        });
        await utils.sleep();
        const apiClient = await getClient();
        const response = await apiClient.send(command);
        return {id:response.id,description:response.description};
    } catch (error) {
        console.error("Error creating API Gateway deployment:", error);
    }
    return null;
}

async function createStage(apiId, stageName, deploymentId, commit, throttleSettings) {
    const app = await config.getConfig('app');
    try {
        const commandParams = {
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
        await utils.sleep();
        const apiClient = await getClient();
        const response = await apiClient.send(command);
    } catch (error) {
        console.error("Error creating API Gateway stage:", error);
    }
}

async function createCustomDomainMapping(domainName, restApiId, stage, basePath) {
    try {
        const command = new CreateBasePathMappingCommand({
            domainName: domainName,
            restApiId: restApiId,
            stage: stage,
            basePath: basePath // Setting the basePath here
        });
        await utils.sleep();
        const apiClient = await getClient();
        const response = await apiClient.send(command);
    } catch (error) {
        console.error("Error creating base path mapping with basePath:", error);
    }
}

/**
 * Lists all deployments for a REST API
 * @param {string} restApiId - The REST API ID
 * @returns {Promise<Array>} Array of deployment objects, or empty array on error
 */
async function listDeployments(restApiId) {
    try {
        const command = new GetDeploymentsCommand({
            restApiId: restApiId
        });

        const apiClient = await getClient();
        const response = await apiClient.send(command);
        return response.items || [];
    } catch (error) {
        console.error("Error listing API deployments:", error);
        return [];
    }
}

/**
 * Lists all stages for a REST API
 * @param {string} restApiId - The REST API ID
 * @returns {Promise<Array>} Array of stage objects, or empty array on error
 */
async function listStages(restApiId) {
    try {
        const command = new GetStagesCommand({
            restApiId: restApiId
        });
        const apiClient = await getClient();
        const response = await apiClient.send(command);
        return response.item || [];
    } catch (error) {
        console.error("Error listing API stages:", error);
        return [];
    }
}

async function updateStage(restApiId, stageName, deploymentId, commit, throttleSettings) {
    const app = await config.getConfig('app');
    const region = await config.getConfig('region');
    try {
        const patchOperations = [
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
                    path: "/*/*/throttle/rateLimit",
                    value: String(throttleSettings.rateLimit)
                });
            }
            if (throttleSettings.burstLimit !== undefined) {
                patchOperations.push({
                    op: "replace",
                    path: "/*/*/throttle/burstLimit",
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
        const response = await apiClient.send(command);

        // Update tags on existing stage
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
            await apiClient.send(tagCommand);
        } catch (tagError) {
            console.error("Error tagging stage:", tagError);
        }
    } catch (error) {
        console.error("Error updating stage deployment:", error);
    }
}

/**
 * Lists all base path mappings for a custom domain
 * @param {string} domainName - The custom domain name
 * @returns {Promise<Array>} Array of base path mapping objects, or empty array on error
 */
async function listBasePathMappings(domainName) {
    try {
        const command = new GetBasePathMappingsCommand({
            domainName: domainName
        });

        const apiClient = await getClient();
        const response = await apiClient.send(command);
        return response.items || [];
    } catch (error) {
        console.error(`Error listing base path mappings for domain ${domainName}:`, error);
        return [];
    }
}

async function createCustomDomainMappingV2(domainName, apiId, stage, basePath) {
    try {
        const command = new CreateApiMappingCommand({
            DomainName: domainName,
            ApiId: apiId,
            Stage: stage,
            ApiMappingKey: basePath
        });
        await utils.sleep();
        const apiClientV2 = await getClientV2();
        const response = await apiClientV2.send(command);
    } catch (error) {
        console.error("Error creating custom domain mapping V2:", error);
    }
}

async function deleteDeployment(apiId, deploymentId) {
    const command = new DeleteDeploymentCommand({
        restApiId: apiId,
        deploymentId: deploymentId
    });

    try {
        await utils.sleep();
        const apiClient = await getClient();
        const response = await apiClient.send(command);
    } catch (error) {
        console.error("Error deleting deployment:", error);
    }
}

module.exports = {createDeployment, createStage, deleteDeployment, createCustomDomainMapping, createCustomDomainMappingV2, listDeployments, listStages, updateStage, listBasePathMappings};