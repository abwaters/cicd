const {
    STSClient,
    GetCallerIdentityCommand
} = require("@aws-sdk/client-sts");
const { getConfig } = require('./config');
const { awsRetry } = require('./utils');

let client = null;

async function getClient() {
    if (!client) {
        const region = await getConfig('region');
        client = new STSClient({ region });
    }
    return client;
}

async function getAccountNumber() {
    try {
        const command = new GetCallerIdentityCommand({});
        const stsClient = await getClient();
        const response = await awsRetry(() => stsClient.send(command));
        console.log(response);
        return response.Account;
    } catch (error) {
        console.error("Error getting account number:", error);
        throw error;
    }
}

module.exports = {getAccountNumber};
