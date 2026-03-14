import { SSMClient, GetParameterCommand, GetParametersByPathCommand } from "@aws-sdk/client-ssm";

const { getConfig } = require('./config');
const { awsRetry } = require('./utils');

let client: SSMClient | null = null;
const psValues = new Map<string, string>();

async function getClient(): Promise<SSMClient> {
    if (!client) {
        const region = await getConfig('region');
        client = new SSMClient({ region });
    }
    return client;
}

async function getParameterValue(parameterName: string, withDecryption: boolean): Promise<string | null> {
    try {
        if( psValues.has(parameterName) ) {
            return psValues.get(parameterName)!;
        }
        const command = new GetParameterCommand({
            Name: parameterName,
            WithDecryption: withDecryption,
        });

        const ssmClient = await getClient();
        const response = await awsRetry(() => ssmClient.send(command));
        const value = response.Parameter?.Value || '';
        psValues.set(parameterName, value);
        return value;
    } catch (error) {
        console.error(`Error fetching parameter ${parameterName}:`, error);
        return null;
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

module.exports = {getParameterValue, getParametersByPath};
