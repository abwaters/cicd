import {
    ECSClient,
    DescribeServicesCommand,
    DescribeTaskDefinitionCommand,
    RegisterTaskDefinitionCommand,
    UpdateServiceCommand,
    ListTaskDefinitionsCommand,
    DeregisterTaskDefinitionCommand,
    waitUntilServicesStable,
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
    try {
        await waitUntilServicesStable(
            { client: ecsClient, maxWaitTime: 600 },
            { cluster, services: [service] }
        );
        return true;
    } catch (error) {
        return false;
    }
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
