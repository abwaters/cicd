import { SSMClient, GetParameterCommand, GetParametersByPathCommand } from "@aws-sdk/client-ssm";

import * as awsContext from './aws-context';
import { awsRetry } from './utils';

let client: SSMClient | null = null;
const psValues = new Map<string, string>();

async function getClient(): Promise<SSMClient> {
    if (!client) {
        const region = await awsContext.getRegion();
        client = new SSMClient({ region });
    }
    return client;
}

async function getParameterValue(parameterName: string, withDecryption: boolean): Promise<string | null> {
    if( psValues.has(parameterName) ) {
        return psValues.get(parameterName)!;
    }
    const command = new GetParameterCommand({
        Name: parameterName,
        WithDecryption: withDecryption,
    });

    const ssmClient = await getClient();
    try {
        const response = await awsRetry(() => ssmClient.send(command));
        const value = response.Parameter?.Value || '';
        psValues.set(parameterName, value);
        return value;
    } catch (error: any) {
        // ParameterNotFound is a normal "missing" signal — return null so the
        // caller can report it as an unresolved reference. Any other error
        // (network, auth, throttling) is a real failure — rethrow.
        if (error?.name === 'ParameterNotFound' || error?.__type === 'ParameterNotFound') {
            return null;
        }
        throw new Error(`Parameter Store lookup failed for '${parameterName}': ${error?.message || error}`, { cause: error });
    }
}

async function getParametersByPath(path: string, withDecryption: boolean): Promise<Record<string, string>> {
    try {
        const command = new GetParametersByPathCommand({
            Path: path,
            Recursive: true,
            WithDecryption: withDecryption,
        });

        const ssmClient = await getClient();
        const response = await awsRetry(() => ssmClient.send(command));

        return (response.Parameters || []).reduce((acc: Record<string, string>, param: any) => {
            acc[param.Name!] = param.Value || "";
            return acc;
        }, {});
    } catch (error) {
        console.error(`Error fetching parameters from path ${path}:`, error);
        return {};
    }
}

export { getParameterValue, getParametersByPath };
