import {
    ECSClient,
    DescribeServicesCommand,
    DescribeTaskDefinitionCommand,
    RegisterTaskDefinitionCommand,
    UpdateServiceCommand,
    ListTaskDefinitionsCommand,
    DeregisterTaskDefinitionCommand,
    TaskDefinition,
    ContainerDefinition,
    RegisterTaskDefinitionCommandInput
} from "@aws-sdk/client-ecs";

const { getConfig } = require('./config');
const { awsRetry } = require('./utils');

let client: ECSClient | null = null;

async function getClient(): Promise<ECSClient> {
    if (!client) {
        const region = await getConfig('region');
        client = new ECSClient({ region });
    }
    return client;
}

export interface ServiceInfo {
    taskDefinitionArn: string;
    desiredCount: number;
    runningCount: number;
    status: string;
}

async function describeService(cluster: string, service: string): Promise<ServiceInfo> {
    const ecsClient = await getClient();
    const command = new DescribeServicesCommand({
        cluster,
        services: [service]
    });
    const response = await awsRetry(() => ecsClient.send(command));
    const svc = response.services?.[0];
    if (!svc) {
        throw new Error(`Service '${service}' not found in cluster '${cluster}'`);
    }
    return {
        taskDefinitionArn: svc.taskDefinition!,
        desiredCount: svc.desiredCount || 0,
        runningCount: svc.runningCount || 0,
        status: svc.status || 'UNKNOWN'
    };
}

async function describeTaskDefinition(taskDefinitionArn: string): Promise<TaskDefinition> {
    const ecsClient = await getClient();
    const command = new DescribeTaskDefinitionCommand({
        taskDefinition: taskDefinitionArn
    });
    const response = await awsRetry(() => ecsClient.send(command));
    if (!response.taskDefinition) {
        throw new Error(`Task definition '${taskDefinitionArn}' not found`);
    }
    return response.taskDefinition;
}

async function registerTaskDefinition(
    currentTaskDef: TaskDefinition,
    containerDefinitions: ContainerDefinition[]
): Promise<string> {
    const ecsClient = await getClient();
    const input: RegisterTaskDefinitionCommandInput = {
        family: currentTaskDef.family!,
        containerDefinitions,
        taskRoleArn: currentTaskDef.taskRoleArn,
        executionRoleArn: currentTaskDef.executionRoleArn,
        networkMode: currentTaskDef.networkMode,
        cpu: currentTaskDef.cpu,
        memory: currentTaskDef.memory,
        requiresCompatibilities: currentTaskDef.requiresCompatibilities,
        volumes: currentTaskDef.volumes,
        runtimePlatform: currentTaskDef.runtimePlatform,
        ephemeralStorage: currentTaskDef.ephemeralStorage,
        proxyConfiguration: currentTaskDef.proxyConfiguration,
        placementConstraints: currentTaskDef.placementConstraints
    };
    const command = new RegisterTaskDefinitionCommand(input);
    const response = await awsRetry(() => ecsClient.send(command));
    return response.taskDefinition!.taskDefinitionArn!;
}

async function updateService(cluster: string, service: string, taskDefinitionArn: string): Promise<void> {
    const ecsClient = await getClient();
    const command = new UpdateServiceCommand({
        cluster,
        service,
        taskDefinition: taskDefinitionArn
    });
    await awsRetry(() => ecsClient.send(command));
}

async function forceUpdateService(cluster: string, service: string): Promise<void> {
    const ecsClient = await getClient();
    const command = new UpdateServiceCommand({
        cluster,
        service,
        forceNewDeployment: true
    });
    await awsRetry(() => ecsClient.send(command));
}

async function waitForServicesStable(cluster: string, service: string): Promise<boolean> {
    const ecsClient = await getClient();
    const maxWaitTime = 600;
    const pollInterval = 15;
    const startTime = Date.now();
    const logger = require('./logger');

    while ((Date.now() - startTime) / 1000 < maxWaitTime) {
        const command = new DescribeServicesCommand({
            cluster,
            services: [service]
        });
        const response = await awsRetry(() => ecsClient.send(command));
        const svc = response.services?.[0];
        if (!svc) {
            logger.verbose(`   - service not found, retrying...`);
            await new Promise(r => setTimeout(r, pollInterval * 1000));
            continue;
        }

        const primary = svc.deployments?.find((d: any) => d.status === 'PRIMARY');
        const activeDeployments = svc.deployments?.filter((d: any) => d.status === 'ACTIVE') || [];
        const elapsed = Math.round((Date.now() - startTime) / 1000);

        if (primary) {
            logger.verbose(`   - [${elapsed}s] primary: ${primary.runningCount}/${primary.desiredCount} running, ${primary.rolloutState || 'unknown'}, ${activeDeployments.length} draining`);
        }

        // Consider stable when primary deployment has desired count running
        // and its rollout is COMPLETED (don't wait for old deployments to fully drain)
        if (primary && primary.rolloutState === 'COMPLETED') {
            return true;
        }

        // Also accept: single deployment with running == desired (older ECS behavior)
        if (svc.deployments?.length === 1 && primary &&
            primary.runningCount === primary.desiredCount &&
            (primary.desiredCount || 0) > 0) {
            return true;
        }

        await new Promise(r => setTimeout(r, pollInterval * 1000));
    }

    logger.verbose(`   - timed out after ${maxWaitTime}s`);
    return false;
}

async function listTaskDefinitionRevisions(family: string): Promise<string[]> {
    const ecsClient = await getClient();
    const arns: string[] = [];
    let nextToken: string | undefined;
    do {
        const command = new ListTaskDefinitionsCommand({
            familyPrefix: family,
            status: 'ACTIVE',
            nextToken
        });
        const response = await awsRetry(() => ecsClient.send(command));
        if (response.taskDefinitionArns) {
            arns.push(...response.taskDefinitionArns);
        }
        nextToken = response.nextToken;
    } while (nextToken);
    return arns;
}

async function deregisterTaskDefinition(taskDefinitionArn: string): Promise<void> {
    const ecsClient = await getClient();
    const command = new DeregisterTaskDefinitionCommand({
        taskDefinition: taskDefinitionArn
    });
    await awsRetry(() => ecsClient.send(command));
}

module.exports = {
    describeService,
    describeTaskDefinition,
    registerTaskDefinition,
    updateService,
    forceUpdateService,
    waitForServicesStable,
    listTaskDefinitionRevisions,
    deregisterTaskDefinition
};
