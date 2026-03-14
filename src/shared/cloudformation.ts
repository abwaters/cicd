import { ListExportsCommand, CloudFormationClient, Export } from "@aws-sdk/client-cloudformation";

const { getConfig } = require('./config');
const { awsRetry } = require('./utils');

let client: CloudFormationClient | null = null;

async function getClient(): Promise<CloudFormationClient> {
    if (!client) {
        const region = await getConfig('region');
        client = new CloudFormationClient({ region });
    }
    return client;
}

async function listExports(): Promise<Export[] | null> {
    try {
        const exports: Export[] = [];
        let nextToken: string | undefined = undefined;
        const cfClient = await getClient();

        do {
            const command = new ListExportsCommand({ NextToken: nextToken });
            const response = await awsRetry(() => cfClient.send(command));
            exports.push(...(response.Exports || []));
            nextToken = response.NextToken;
        } while (nextToken);

        return exports;
    } catch (error) {
        console.error(error);
    }
    return null;
}

module.exports = {listExports};
