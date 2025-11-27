const sns = require('./shared/sns');
const lambda = require('./shared/lambda');
const apigw = require('./shared/apigw');
const cicd = require('./shared/cicd');

async function main() {
    const account = await cicd.getConfig("account");
    const region = await cicd.getConfig("region");

    console.time("api cicd");
    console.log(`Preparing clean api gateway deployments and lambda aliases/versions...`);

    // get list of exports from cloudformation
    const apis = await cicd.getExportsByType('api');
    const topics = await cicd.getExportsByType('sns');
    const apiFunctions = await cicd.getLambdaExports('api');
    const snsFunctions = await cicd.getLambdaExports('sns');
    const functions = [...apiFunctions,...snsFunctions];
    const apiCount = apis.length, functionCount = functions.length;
    let activeCommits = new Map(),
        deletedDeployments=0,
        deletedAliases=0,
        deletedVersions=0;

    console.log(`\nChecking apis to clean unused deployments:`);
    for(const api of apis) {
        const apiId = api.value;
        console.log(` * Checking api ${api.name} [${api.value}]...`);
        const stages = await apigw.listStages(apiId);
        const activeDeployments = new Map();
        for(const s of stages) {
            activeCommits.set(s.variables.Commit,true);
            if( !activeDeployments.has(s.deploymentId) ) {
                activeDeployments.set(s.deploymentId,`'${s.stageName}'`);
            }else{
                const v = activeDeployments.get(s.deploymentId);
                activeDeployments.set(s.deploymentId,` and '${s.stageName}'`);
            }
        }

        const deployments = await apigw.listDeployments(apiId);
        for(const d of deployments) {
            if( !activeDeployments.has(d.id) ) {
                console.log(`   - Deployment '${d.id}' can be deleted.`);
                await apigw.deleteDeployment(apiId,d.id);
                deletedDeployments++;
            }else{
                console.log(`   - Deployment '${d.id}' is being used by stage ${activeDeployments.get(d.id)}.`);
            }
        }
    }

    console.log(`\nChecking sns topics to clean versions and aliases:`);
    for(const topic of topics) {
        console.log(` * Checking topic ${topic.name}...`);
        const subscriptions = await sns.listSubscriptionsByTopic(topic.value);
        for(const subscription of subscriptions) {
            const f = await lambda.describeFunction(subscription.endpoint);
            // arn:aws:lambda:us-east-1:123456789012:function:myapp-slack-command:myapp-feef524af
            const parts = subscription.endpoint.split(':');
            if( parts.length === 8 ) {
                console.log(`   - Lambda alias '${parts[7]}' is being used by topic.`);
                activeCommits.set(parts[7],true);
            }
        }
    }

    console.log(`\nCheck functions to clean unused aliases and versions:`);
    for(const f of functions) {
        console.log(` * Checking function '${f.value}'...`);
        const functionName = f.value;
        const activeVersions = new Map();
        const aliases = await lambda.listAliases(functionName);
        for(const a of aliases) {
            if( activeCommits.has(a.alias) ) {
                console.log(`   - Active alias '${a.alias}'.`);
                activeVersions.set(a.version,true);
            }else{
                console.log(`   - Inactive alias '${a.alias}' will be deleted.`);
                await lambda.deleteAlias(functionName,a.alias);
                deletedAliases++;
            }
        }

        const versions = await lambda.listVersions(functionName);
        for(const v of versions) {
            if( v.version === '$LATEST' ) {
                continue;
            }
            if( activeVersions.has(v.version) ) {
                console.log(`   - Active version '${v.version}'.`);
            }else{
                console.log(`   - Inactive version '${v.version}' will be deleted.`);
                await lambda.deleteVersion(functionName,v.version);
                deletedVersions++;
            }
        }
    }
    console.log(`\nDeleted ${deletedDeployments} deployments for ${apiCount} apis.`);
    console.log(`Deleted ${deletedAliases} aliases and ${deletedVersions} versions for ${functionCount} functions.\n`);
    console.log();
    console.timeEnd("api cicd");
}

main();