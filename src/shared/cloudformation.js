const {ListExportsCommand, CloudFormationClient} = require("@aws-sdk/client-cloudformation");
const { getConfig } = require('./config');
const { awsRetry } = require('./utils');

let client = null;

async function getClient() {
    if (!client) {
        const region = await getConfig('region');
        client = new CloudFormationClient({ region });
    }
    return client;
}

async function listExports() {
    try {
        const exports = [];
        let nextToken = undefined;
        const cfClient = await getClient();

        do {
            const command = new ListExportsCommand({ NextToken: nextToken });
            const response = await awsRetry(() => cfClient.send(command));
            exports.push(...response.Exports);
            nextToken = response.NextToken;
        } while (nextToken);

        return exports;
    } catch (error) {
        console.error(error);
    }
    return null;
}

module.exports = {listExports};
