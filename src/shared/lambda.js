const {
    PublishVersionCommand,
    ListVersionsByFunctionCommand,
    ListAliasesCommand,
    DeleteAliasCommand,
    CreateAliasCommand,
    GetFunctionCommand,
    DeleteFunctionCommand,
    ListTagsCommand,
    LambdaClient,
    UpdateFunctionConfigurationCommand,
    PutProvisionedConcurrencyConfigCommand,
    DeleteProvisionedConcurrencyConfigCommand,
    AddPermissionCommand
} = require("@aws-sdk/client-lambda");
const { getConfig } = require('./config');

let client = null;

async function getClient() {
    if (!client) {
        const region = await getConfig('region');
        client = new LambdaClient({ region });
    }
    return client;
}

async function publishNewVersion(functionName,commit) {
    try {
        // Create the command with the necessary parameters
        const command = new PublishVersionCommand({
            FunctionName: functionName,
            Description: commit
        });
        const lambdaClient = await getClient();
        const response = await lambdaClient.send(command);
        return {version:response.Version,description:response.Description,arn:response.FunctionArn};
    } catch (error) {
        console.error("Error publishing Lambda version:", error);
    }
    return '';
}

async function listVersions(functionName) {
    try {
        const command = new ListVersionsByFunctionCommand({
            FunctionName: functionName
        });
        const lambdaClient = await getClient();
        const response = await lambdaClient.send(command);
        const versions = [];
        for(const version of (response.Versions || [])) {
            versions.push({version:version.Version,description:version.Description});
        }
        return versions;
    } catch (error) {
        console.error("Error listing Lambda versions:", error);
        process.exit(-1);
    }
    return [];
}

async function listAliases(functionName) {
    try {
        const command = new ListAliasesCommand({
            FunctionName: functionName
        });
        const lambdaClient = await getClient();
        const response = await lambdaClient.send(command);
        const aliases = [];
        for(const alias of (response.Aliases || [])) {
            aliases.push({alias:alias.Name,version:alias.FunctionVersion});
        }
        return aliases;
    } catch (error) {
        console.error("Error listing Lambda aliases:", error);
    }
    return [];
}

async function describeFunction(functionName) {
    try {
        const command = new GetFunctionCommand({
            FunctionName: functionName
        });
        const lambdaClient = await getClient();
        const response = await lambdaClient.send(command);
        return response.Configuration;
    } catch (error) {
        console.error("Error retrieving Lambda function details:", error);
    }
    return null;
}

async function listFunctionTags(functionArn) {
    try {
        const command = new ListTagsCommand({
            Resource: functionArn
        });
        const lambdaClient = await getClient();
        const response = await lambdaClient.send(command);
        return response.Tags || {};
    } catch (error) {
        console.error("Error listing Lambda function tags:", error);
    }
    return {};
}

async function createAlias(functionName, commit, functionVersion) {
    try {
        const command = new CreateAliasCommand({
            FunctionName: functionName,
            Name: commit,
            FunctionVersion: functionVersion,
            Description: commit
        });
        const lambdaClient = await getClient();
        const response = await lambdaClient.send(command);
        return response;
    } catch (error) {
        console.error("Error creating Lambda alias:", error);
    }
    return null;
}

async function addFunctionPermission(functionName, sourceArn,principal) {
    try {
        // Create a deterministic StatementId to avoid accumulation
        // Use a hash of the source ARN and principal to make it unique but repeatable
        const crypto = require('crypto');
        const hash = crypto.createHash('sha256')
            .update(`${sourceArn}-${principal}`)
            .digest('hex')
            .substring(0, 16);
        const statementId = `invoke-${hash}`;

        const command = new AddPermissionCommand({
            FunctionName: functionName,
            StatementId: statementId,
            Principal: principal,
            Action: "lambda:InvokeFunction",
            SourceArn: sourceArn,
        });
        const lambdaClient = await getClient();
        const response = await lambdaClient.send(command);
    } catch (error) {
        // If permission already exists, that's fine - it means we've already added it
        if (error.name === 'ResourceConflictException') {
            // Permission already exists, no action needed
        } else {
            console.error("Error adding function permission:", error);
        }
    }
}

async function deleteAlias(functionName, aliasName) {
    const command = new DeleteAliasCommand({
        FunctionName: functionName,
        Name: aliasName
    });

    try {
        const lambdaClient = await getClient();
        const response = await lambdaClient.send(command);
    } catch (error) {
        console.error("Error deleting alias:", error);
    }
}

async function deleteVersion(functionName, versionNumber) {
    const command = new DeleteFunctionCommand({
        FunctionName: `${functionName}:${versionNumber}`
    });

    try {
        const lambdaClient = await getClient();
        const response = await lambdaClient.send(command);
    } catch (error) {
        console.error("Error deleting function version:", error);
    }
}

async function updateProvisionedConcurrency(functionName,aliasName,concurrency) {
    const lambdaClient = await getClient();
    if( concurrency ) {
        try {
            await lambdaClient.send(new PutProvisionedConcurrencyConfigCommand({
                FunctionName: functionName,
                Qualifier: aliasName,
                ProvisionedConcurrentExecutions: concurrency
            }));
        }catch(e) {
            console.error("Error setting concurrency on lambda function:", e);
        }
    }else{
        try {
            await lambdaClient.send(new DeleteProvisionedConcurrencyConfigCommand({
                FunctionName: functionName,
                Qualifier: aliasName,
            }));
        }catch(e) {
            console.error("Error removing concurrency on lambda function:", e);
        }
    }
}

/*
const newEnvironmentVariables = {
    "KEY1": "newValue1",
    "KEY2": "newValue2",
};

aws lambda update-function-configuration --function-name myapp-ads --environment "Variables={DDB_ADS_TABLE_NAME=myapp-ads}"
    myapp-ads
{DDB_ADS_TABLE_NAME=myapp-ads}
 */
async function updateEnvironmentVariables(functionName, envVars) {
    try {
        const command = new UpdateFunctionConfigurationCommand({
            FunctionName: functionName,
            Environment: {
                Variables: envVars
            }
        });
        const lambdaClient = await getClient();
        const response = await lambdaClient.send(command);
        //console.log(response);
    } catch (error) {
        console.error("Error updating Lambda environment variables:", error);
    }
}

module.exports = {
    deleteVersion,
    deleteAlias,
    listAliases,
    listVersions,
    publishNewVersion,
    describeFunction,
    listFunctionTags,
    createAlias,
    addFunctionPermission,
    updateProvisionedConcurrency,
    updateEnvironmentVariables};