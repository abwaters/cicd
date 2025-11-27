const {ListExportsCommand, CloudFormationClient} = require("@aws-sdk/client-cloudformation");

const client = new CloudFormationClient({ region: "us-east-1" });

async function listExports() {
    try {
        const command = new ListExportsCommand({});
        const response = await client.send(command);
        return [...response.Exports];
    } catch (error) {
        console.error(error);
    }
    return null;
}

module.exports = {listExports};