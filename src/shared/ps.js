const { SSMClient, GetParameterCommand, GetParametersByPathCommand } = require("@aws-sdk/client-ssm");

const client = new SSMClient({ region: "us-east-1" });
const psValues = new Map();

async function getParameterValue(parameterName, withDecryption) {
    try {
        if( psValues.has(parameterName) ) {
            return psValues.get(parameterName);
        }
        const command = new GetParameterCommand({
            Name: parameterName,
            WithDecryption: withDecryption, // Set to true if it's a SecureString
        });

        const response = await client.send(command);
        const value = response.Parameter.Value || '';
        psValues.set(parameterName, value);
        return value;
    } catch (error) {
        console.error(`Error fetching parameter ${parameterName}:`, error);
        return null;
    }
}

async function getParametersByPath(path, withDecryption) {
    try {
        const command = new GetParametersByPathCommand({
            Path: path,
            Recursive: true,
            WithDecryption: withDecryption,
        });

        const response = await client.send(command);

        return response.Parameters.reduce((acc, param) => {
            acc[param.Name] = param.Value || "";
            return acc;
        }, {});
    } catch (error) {
        console.error(`Error fetching parameters from path ${path}:`, error);
        return {};
    }
}

module.exports = {getParameterValue,getParametersByPath};