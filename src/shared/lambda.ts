import {
    PublishVersionCommand,
    ListVersionsByFunctionCommand,
    ListAliasesCommand,
    DeleteAliasCommand,
    CreateAliasCommand,
    GetFunctionCommand,
    DeleteFunctionCommand,
    ListTagsCommand,
    LambdaClient,
    UpdateFunctionConfigurationCommand,
    PutProvisionedConcurrencyConfigCommand,
    DeleteProvisionedConcurrencyConfigCommand,
    AddPermissionCommand,
    FunctionConfiguration,
    CreateAliasCommandOutput,
    ListEventSourceMappingsCommand,
    CreateEventSourceMappingCommand,
    UpdateEventSourceMappingCommand,
    DeleteEventSourceMappingCommand
} from "@aws-sdk/client-lambda";
import * as crypto from 'crypto';
import { VersionInfo, VersionListItem, AliasInfo, EventSourceMappingInfo, EventSourceMappingOptions } from '../types';

import { getConfig } from './config';
import { awsRetry } from './utils';

let client: LambdaClient | null = null;

async function getClient(): Promise<LambdaClient> {
    if (!client) {
        const region = await getConfig('region');
        client = new LambdaClient({ region });
    }
    return client;
}

async function publishNewVersion(functionName: string, commit: string): Promise<VersionInfo | ''> {
    try {
        const command = new PublishVersionCommand({
            FunctionName: functionName,
            Description: commit
        });
        const lambdaClient = await getClient();
        const response = await awsRetry(() => lambdaClient.send(command));
        return {version: response.Version!, description: response.Description!, arn: response.FunctionArn!};
    } catch (error) {
        console.error("Error publishing Lambda version:", error);
    }
    return '';
}

async function listVersions(functionName: string): Promise<VersionListItem[]> {
    try {
        const command = new ListVersionsByFunctionCommand({
            FunctionName: functionName
        });
        const lambdaClient = await getClient();
        const response = await awsRetry(() => lambdaClient.send(command));
        const versions: VersionListItem[] = [];
        for(const version of (response.Versions || [])) {
            versions.push({version: version.Version!, description: version.Description!});
        }
        return versions;
    } catch (error) {
        console.error("Error listing Lambda versions:", error);
        return [];
    }
}

async function listAliases(functionName: string): Promise<AliasInfo[]> {
    try {
        const command = new ListAliasesCommand({
            FunctionName: functionName
        });
        const lambdaClient = await getClient();
        const response = await awsRetry(() => lambdaClient.send(command));
        const aliases: AliasInfo[] = [];
        for(const alias of (response.Aliases || [])) {
            aliases.push({alias: alias.Name!, version: alias.FunctionVersion!});
        }
        return aliases;
    } catch (error) {
        console.error("Error listing Lambda aliases:", error);
        return [];
    }
}

async function describeFunction(functionName: string): Promise<FunctionConfiguration | null | undefined> {
    try {
        const command = new GetFunctionCommand({
            FunctionName: functionName
        });
        const lambdaClient = await getClient();
        const response = await awsRetry(() => lambdaClient.send(command));
        return response.Configuration;
    } catch (error) {
        console.error("Error retrieving Lambda function details:", error);
        return null;
    }
}

async function listFunctionTags(functionArn: string): Promise<Record<string, string>> {
    try {
        const command = new ListTagsCommand({
            Resource: functionArn
        });
        const lambdaClient = await getClient();
        const response = await awsRetry(() => lambdaClient.send(command));
        return response.Tags || {};
    } catch (error) {
        console.error("Error listing Lambda function tags:", error);
        return {};
    }
}

async function createAlias(functionName: string, commit: string, functionVersion: string): Promise<CreateAliasCommandOutput | null> {
    try {
        const command = new CreateAliasCommand({
            FunctionName: functionName,
            Name: commit,
            FunctionVersion: functionVersion,
            Description: commit
        });
        const lambdaClient = await getClient();
        const response = await awsRetry(() => lambdaClient.send(command));
        return response;
    } catch (error) {
        console.error("Error creating Lambda alias:", error);
    }
    return null;
}

async function addFunctionPermission(functionName: string, sourceArn: string, principal: string): Promise<void> {
    try {
        // Create a deterministic StatementId to avoid accumulation
        // Use a hash of the source ARN and principal to make it unique but repeatable
        const hash = crypto.createHash('sha256')
            .update(`${sourceArn}-${principal}`)
            .digest('hex')
            .substring(0, 16);
        const statementId = `invoke-${hash}`;

        const command = new AddPermissionCommand({
            FunctionName: functionName,
            StatementId: statementId,
            Principal: principal,
            Action: "lambda:InvokeFunction",
            SourceArn: sourceArn,
        });
        const lambdaClient = await getClient();
        await awsRetry(() => lambdaClient.send(command));
    } catch (error: any) {
        // If permission already exists, that's fine - it means we've already added it
        if (error.name === 'ResourceConflictException') {
            // Permission already exists, no action needed
        } else {
            console.error("Error adding function permission:", error);
        }
    }
}

async function deleteAlias(functionName: string, aliasName: string): Promise<void> {
    const command = new DeleteAliasCommand({
        FunctionName: functionName,
        Name: aliasName
    });

    try {
        const lambdaClient = await getClient();
        await awsRetry(() => lambdaClient.send(command));
    } catch (error) {
        console.error("Error deleting alias:", error);
    }
}

async function deleteVersion(functionName: string, versionNumber: string): Promise<void> {
    const command = new DeleteFunctionCommand({
        FunctionName: `${functionName}:${versionNumber}`
    });

    try {
        const lambdaClient = await getClient();
        await awsRetry(() => lambdaClient.send(command));
    } catch (error) {
        console.error("Error deleting function version:", error);
    }
}

async function updateProvisionedConcurrency(functionName: string, aliasName: string, concurrency: number): Promise<void> {
    const lambdaClient = await getClient();
    if( concurrency ) {
        try {
            await awsRetry(() => lambdaClient.send(new PutProvisionedConcurrencyConfigCommand({
                FunctionName: functionName,
                Qualifier: aliasName,
                ProvisionedConcurrentExecutions: concurrency
            })));
        }catch(e) {
            console.error("Error setting concurrency on lambda function:", e);
        }
    }else{
        try {
            await awsRetry(() => lambdaClient.send(new DeleteProvisionedConcurrencyConfigCommand({
                FunctionName: functionName,
                Qualifier: aliasName,
            })));
        }catch(e) {
            console.error("Error removing concurrency on lambda function:", e);
        }
    }
}

async function listEventSourceMappings(eventSourceArn: string): Promise<EventSourceMappingInfo[]> {
    const mappings: EventSourceMappingInfo[] = [];
    try {
        const lambdaClient = await getClient();
        let marker: string | undefined = undefined;
        do {
            const command = new ListEventSourceMappingsCommand({
                EventSourceArn: eventSourceArn,
                Marker: marker
            });
            const response: any = await awsRetry(() => lambdaClient.send(command));
            for (const m of (response.EventSourceMappings || [])) {
                mappings.push({
                    uuid: m.UUID!,
                    functionArn: m.FunctionArn!,
                    eventSourceArn: m.EventSourceArn!,
                    state: m.State,
                    batchSize: m.BatchSize,
                    maximumBatchingWindowInSeconds: m.MaximumBatchingWindowInSeconds,
                    maximumConcurrency: m.ScalingConfig?.MaximumConcurrency
                });
            }
            marker = response.NextMarker;
        } while (marker);
    } catch (error) {
        console.error("Error listing Lambda event source mappings:", error);
    }
    return mappings;
}

async function createEventSourceMapping(eventSourceArn: string, functionArn: string, opts: EventSourceMappingOptions = {}): Promise<string | null> {
    try {
        const command = new CreateEventSourceMappingCommand({
            EventSourceArn: eventSourceArn,
            FunctionName: functionArn,
            Enabled: true,
            BatchSize: opts.batchSize,
            MaximumBatchingWindowInSeconds: opts.maximumBatchingWindowInSeconds,
            ScalingConfig: opts.maximumConcurrency !== undefined
                ? { MaximumConcurrency: opts.maximumConcurrency }
                : undefined
        });
        const lambdaClient = await getClient();
        const response = await awsRetry(() => lambdaClient.send(command));
        return response.UUID || null;
    } catch (error) {
        console.error("Error creating Lambda event source mapping:", error);
    }
    return null;
}

async function updateEventSourceMapping(uuid: string, opts: EventSourceMappingOptions): Promise<void> {
    try {
        const command = new UpdateEventSourceMappingCommand({
            UUID: uuid,
            BatchSize: opts.batchSize,
            MaximumBatchingWindowInSeconds: opts.maximumBatchingWindowInSeconds,
            ScalingConfig: opts.maximumConcurrency !== undefined
                ? { MaximumConcurrency: opts.maximumConcurrency }
                : undefined
        });
        const lambdaClient = await getClient();
        await awsRetry(() => lambdaClient.send(command));
    } catch (error) {
        console.error("Error updating Lambda event source mapping:", error);
    }
}

async function deleteEventSourceMapping(uuid: string): Promise<void> {
    try {
        const command = new DeleteEventSourceMappingCommand({ UUID: uuid });
        const lambdaClient = await getClient();
        await awsRetry(() => lambdaClient.send(command));
    } catch (error: any) {
        if (error.name === 'ResourceNotFoundException') {
            return;
        }
        console.error("Error deleting Lambda event source mapping:", error);
    }
}

async function updateEnvironmentVariables(functionName: string, envVars: Record<string, string>): Promise<void> {
    try {
        const command = new UpdateFunctionConfigurationCommand({
            FunctionName: functionName,
            Environment: {
                Variables: envVars
            }
        });
        const lambdaClient = await getClient();
        await awsRetry(() => lambdaClient.send(command));
    } catch (error) {
        console.error("Error updating Lambda environment variables:", error);
    }
}

export {
    deleteVersion,
    deleteAlias,
    listAliases,
    listVersions,
    publishNewVersion,
    describeFunction,
    listFunctionTags,
    createAlias,
    addFunctionPermission,
    updateProvisionedConcurrency,
    updateEnvironmentVariables,
    listEventSourceMappings,
    createEventSourceMapping,
    updateEventSourceMapping,
    deleteEventSourceMapping
};
