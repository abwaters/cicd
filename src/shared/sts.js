const {
    STSClient,
    GetCallerIdentityCommand
} = require("@aws-sdk/client-sts");

const client = new STSClient({ region: "us-east-1" });

async function getAccountNumber() {
    try {
        const command = new GetCallerIdentityCommand({});
        const response = await client.send(command);
        console.log(response);
        return response.Account;
    } catch (error) {
        console.error("Error getting account number:", error);
        throw error;
    }
}

module.exports = {getAccountNumber};