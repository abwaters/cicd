const { SSMClient, GetParameterCommand, GetParametersByPathCommand } = require("@aws-sdk/client-ssm");
const { getConfig } = require('./config');

let client = null;
const psValues = new Map();

async function getClient() {
    if (!client) {
        const region = await getConfig('region');
        client = new SSMClient({ region });
    }
    return client;
}

async function getParameterValue(parameterName, withDecryption) {
    try {
        if( psValues.has(parameterName) ) {
            return psValues.get(parameterName);
        }
        const command = new GetParameterCommand({
            Name: parameterName,
            WithDecryption: withDecryption, // Set to true if it's a SecureString
        });

        const ssmClient = await getClient();
        const response = await ssmClient.send(command);
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

        const ssmClient = await getClient();
        const response = await ssmClient.send(command);

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