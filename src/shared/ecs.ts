import {
    ECSClient,
    DescribeServicesCommand,
    DescribeTaskDefinitionCommand,
    RegisterTaskDefinitionCommand,
    UpdateServiceCommand,
    ListTaskDefinitionsCommand,
    DeregisterTaskDefinitionCommand,
    ListTasksCommand,
    DescribeTasksCommand,
    TaskDefinition,
    ContainerDefinition,
    RegisterTaskDefinitionCommandInput
} from "@aws-sdk/client-ecs";

import * as awsContext from './aws-context';
import { awsRetry, formatDuration } from './utils';
import * as logger from './logger';

let client: ECSClient | null = null;

async function getClient(): Promise<ECSClient> {
    if (!client) {
        const region = await awsContext.getRegion();
        client = new ECSClient({ region });
    }
    return client;
}

export interface ServiceInfo {
    taskDefinitionArn: string;
    desiredCount: number;
    runningCount: number;
    pendingCount: number;
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
        pendingCount: svc.pendingCount || 0,
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
    containerDefinitions: ContainerDefinition[],
    overrides?: { cpu?: string; memory?: string }
): Promise<string> {
    const ecsClient = await getClient();
    const input: RegisterTaskDefinitionCommandInput = {
        family: currentTaskDef.family!,
        containerDefinitions,
        taskRoleArn: currentTaskDef.taskRoleArn,
        executionRoleArn: currentTaskDef.executionRoleArn,
        networkMode: currentTaskDef.networkMode,
        cpu: overrides?.cpu || currentTaskDef.cpu,
        memory: overrides?.memory || currentTaskDef.memory,
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

export interface StabilityResult {
    stable: boolean;
    failed: boolean;
    failureReason?: string;
    stoppedTaskReasons?: string[];
}

async function getStoppedTaskReasons(cluster: string, service: string): Promise<string[]> {
    const ecsClient = await getClient();
    const reasons: string[] = [];

    try {
        const listCommand = new ListTasksCommand({
            cluster,
            serviceName: service,
            desiredStatus: 'STOPPED'
        });
        const listResponse = await awsRetry(() => ecsClient.send(listCommand));
        const taskArns = listResponse.taskArns || [];

        if (taskArns.length === 0) return reasons;

        // Only check the most recent few stopped tasks
        const recentArns = taskArns.slice(-3);
        const describeCommand = new DescribeTasksCommand({
            cluster,
            tasks: recentArns
        });
        const describeResponse = await awsRetry(() => ecsClient.send(describeCommand));

        for (const task of (describeResponse.tasks || [])) {
            const containers = task.containers || [];
            for (const container of containers) {
                if (container.exitCode && container.exitCode !== 0) {
                    const reason = container.reason || task.stoppedReason || `exit code ${container.exitCode}`;
                    reasons.push(`${container.name}: ${reason} (exit code ${container.exitCode})`);
                }
            }
            if (reasons.length === 0 && task.stoppedReason) {
                reasons.push(task.stoppedReason);
            }
        }
    } catch {
        // Non-critical - don't fail the whole flow if we can't get stopped task reasons
    }

    return [...new Set(reasons)]; // deduplicate
}

async function waitForServicesStable(cluster: string, service: string): Promise<StabilityResult> {
    const ecsClient = await getClient();
    const maxWaitTime = 600;
    const pollInterval = 15;
    const startTime = Date.now();

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
            const drainingTasks = activeDeployments.reduce((sum: number, d: any) => sum + (d.runningCount || 0), 0);
            const parts = [
                `desired=${primary.desiredCount}`,
                `running=${primary.runningCount}`,
                primary.rolloutState || 'unknown'
            ];
            if (drainingTasks > 0) {
                parts.push(`${drainingTasks} draining`);
            }
            logger.verbose(`   - [${formatDuration(elapsed)}] ${parts.join(', ')}`);
        }

        // Detect failed rollout early
        if (primary && primary.rolloutState === 'FAILED') {
            const failureReason = primary.rolloutStateReason || 'Deployment failed';
            logger.verbose(`   - FAILED: ${failureReason}`);
            const stoppedReasons = await getStoppedTaskReasons(cluster, service);
            return { stable: false, failed: true, failureReason, stoppedTaskReasons: stoppedReasons };
        }

        // Consider stable when primary deployment rollout is COMPLETED
        if (primary && primary.rolloutState === 'COMPLETED') {
            return { stable: true, failed: false };
        }

        // Also accept: single deployment with running == desired (older ECS behavior)
        if (svc.deployments?.length === 1 && primary &&
            primary.runningCount === primary.desiredCount &&
            (primary.desiredCount || 0) > 0) {
            return { stable: true, failed: false };
        }

        await new Promise(r => setTimeout(r, pollInterval * 1000));
    }

    // Timed out - check for stopped tasks to give a useful reason
    logger.verbose(`   - timed out after ${formatDuration(maxWaitTime)}`);
    const stoppedReasons = await getStoppedTaskReasons(cluster, service);
    return { stable: false, failed: false, failureReason: 'Timed out waiting for stability', stoppedTaskReasons: stoppedReasons };
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

export {
    describeService,
    describeTaskDefinition,
    registerTaskDefinition,
    updateService,
    forceUpdateService,
    waitForServicesStable,
    getStoppedTaskReasons,
    listTaskDefinitionRevisions,
    deregisterTaskDefinition
};
