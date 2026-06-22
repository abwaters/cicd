import {
    BatchClient,
    RegisterJobDefinitionCommand,
    DescribeJobDefinitionsCommand,
    DeregisterJobDefinitionCommand,
    SubmitJobCommand,
    RegisterJobDefinitionCommandInput,
    JobDefinition,
    KeyValuePair
} from "@aws-sdk/client-batch";

import * as awsContext from './aws-context';
import { awsRetry } from './utils';

let client: BatchClient | null = null;

async function getClient(): Promise<BatchClient> {
    if (!client) {
        const region = await awsContext.getRegion();
        client = new BatchClient({ region });
    }
    return client;
}

export interface RegisterJobDefinitionParams {
    name: string;
    image: string;
    vcpu?: number;
    memory?: number;
    command?: string[];
    jobRoleArn?: string;
    executionRoleArn?: string;
    logGroup?: string;
    environment?: Record<string, string>;
    tags?: Record<string, string>;
}

export interface RegisteredJobDefinition {
    name: string;
    arn: string;
    revision: number;
}

// Register a new container job-definition revision. AWS Batch has no
// "Description" field (unlike Lambda PublishVersion), so the commit identity is
// carried in `tags` and the COMMIT container env. Submitting / EventBridge by
// name always resolves the latest ACTIVE revision, so a new revision is what the
// schedule picks up next — no infra mutation required.
async function registerJobDefinition(params: RegisterJobDefinitionParams): Promise<RegisteredJobDefinition> {
    const batchClient = await getClient();
    const region = await awsContext.getRegion();

    const environment: KeyValuePair[] = Object.entries(params.environment || {})
        .map(([name, value]) => ({ name, value }));

    const input: RegisterJobDefinitionCommandInput = {
        jobDefinitionName: params.name,
        type: 'container',
        tags: params.tags,
        propagateTags: true,
        containerProperties: {
            image: params.image,
            command: params.command,
            jobRoleArn: params.jobRoleArn,
            executionRoleArn: params.executionRoleArn,
            resourceRequirements: [
                { type: 'VCPU', value: String(params.vcpu ?? 1) },
                { type: 'MEMORY', value: String(params.memory ?? 1024) }
            ],
            environment,
            logConfiguration: params.logGroup
                ? {
                    logDriver: 'awslogs',
                    options: {
                        'awslogs-group': params.logGroup,
                        'awslogs-region': region,
                        'awslogs-stream-prefix': 'batch'
                    }
                }
                : undefined
        }
    };

    const response = await awsRetry(() => batchClient.send(new RegisterJobDefinitionCommand(input)));
    return {
        name: response.jobDefinitionName!,
        arn: response.jobDefinitionArn!,
        revision: response.revision!
    };
}

// Describe ACTIVE revisions for a job definition name, newest revision first.
async function describeJobDefinitions(name: string, status: string = 'ACTIVE'): Promise<JobDefinition[]> {
    const batchClient = await getClient();
    const defs: JobDefinition[] = [];
    let nextToken: string | undefined;
    do {
        const command = new DescribeJobDefinitionsCommand({
            jobDefinitionName: name,
            status,
            nextToken
        });
        const response = await awsRetry(() => batchClient.send(command));
        if (response.jobDefinitions) {
            defs.push(...response.jobDefinitions);
        }
        nextToken = response.nextToken;
    } while (nextToken);
    return defs.sort((a, b) => (b.revision || 0) - (a.revision || 0));
}

// Latest ACTIVE revision for a name, or null if none registered yet.
async function describeLatestJobDefinition(name: string): Promise<JobDefinition | null> {
    const defs = await describeJobDefinitions(name, 'ACTIVE');
    return defs[0] || null;
}

async function deregisterJobDefinition(arn: string): Promise<void> {
    const batchClient = await getClient();
    await awsRetry(() => batchClient.send(new DeregisterJobDefinitionCommand({ jobDefinition: arn })));
}

// Submit a job against the latest ACTIVE revision (by name). Used by `run`.
async function submitJob(
    jobQueue: string,
    jobDefinition: string,
    jobName: string,
    environment?: Record<string, string>
): Promise<string> {
    const batchClient = await getClient();
    const overrides = environment
        ? { environment: Object.entries(environment).map(([name, value]) => ({ name, value })) }
        : undefined;
    const response = await awsRetry(() => batchClient.send(new SubmitJobCommand({
        jobQueue,
        jobDefinition,
        jobName,
        containerOverrides: overrides
    })));
    return response.jobId!;
}

export {
    registerJobDefinition,
    describeJobDefinitions,
    describeLatestJobDefinition,
    deregisterJobDefinition,
    submitJob
};
