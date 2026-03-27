import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { getConfig } from './config';
import { awsRetry } from './utils';

let client: STSClient | null = null;

async function getClient(): Promise<STSClient> {
    if (!client) {
        const region = await getConfig('region');
        client = new STSClient({ region });
    }
    return client;
}

async function getAccountNumber(): Promise<string> {
    try {
        const command = new GetCallerIdentityCommand({});
        const stsClient = await getClient();
        const response = await awsRetry(() => stsClient.send(command));
        console.log(response);
        return response.Account!;
    } catch (error) {
        console.error("Error getting account number:", error);
        throw error;
    }
}

export { getAccountNumber };
