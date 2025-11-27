const options = require('./shared/options');
const cicd = require('./shared/cicd');
const lambda = require('./shared/lambda');
const apigw = require('./shared/apigw');
const sns = require('./shared/sns');

async function main() {
    //const subs = await sns.listSubscriptionsByTopic('arn:aws:sns:us-east-1:907688428238:ccfw-command');
    //process.exit(-1);

    const account = await cicd.getConfig("account");
    const region = await cicd.getConfig("region");
    let args = process.argv.slice(2);
    const o = options.getOptions(args);
    args = options.stripOptions(args);

    console.time("api cicd");
    console.log(`Collecting information for stages...\n`);
    const stages = await cicd.getConfig("stages");
    const apis = await cicd.getExportsByType('api');
    const topics = await cicd.getExportsByType('sns');
    const topicFunctions = await cicd.getLambdaExports('sns');
    const apiFunctions = await cicd.getLambdaExports('api');
    const functions = [...apiFunctions,...topicFunctions];
    const stagesInfo = {}, funcAliases = new Map(), funcVersions = new Map() ;
    for(const stage of stages) {
        //console.log(` * preparing stage '${stage.stage}`);
        stagesInfo[stage.stage] = {
            name: stage.stage,
            commits: {},
            details: [],
        }
    }

    for(const api of apis) {
        const apiId = api.value;
        //console.log(` * Checking api ${api.Name} [${api.Value}]...`);
        const apistages = await apigw.listStages(apiId);
        for(const s of apistages) {
            const name = api.name;
            const stagename = s.stageName;
            const commit = s.variables.Commit;
            const apiInfo = {
                name,
                stage: stagename,
                commit: s.variables.Commit,
                functions: []
            };
            if( !stagesInfo[stagename].commits.hasOwnProperty(commit) ) {
                stagesInfo[stagename].commits[commit] = 1;
            }else{
                stagesInfo[stagename].commits[commit]++ ;
            }
            stagesInfo[stagename].details.push(apiInfo);
            stagesInfo[stagename].functions = [];
            if( o.details ) {
                for(const f of functions) {
                    const finfo = {
                        name: f.value,
                        commit: 'not deployed'
                    };
                    let aliases = funcAliases.get(f.value);
                    if( !aliases ) {
                        aliases = await lambda.listAliases(f.value);
                    }
                    const matchingAlias = aliases.filter(a=>a.alias==commit);
                    if( matchingAlias.length > 0 ) {
                        let versions = funcVersions.get(f.value);
                        if( !versions ) {
                            versions = await lambda.listVersions(f.value);
                        }
                        const v = versions.filter(v=>v.version==matchingAlias[0].version)[0];
                        finfo.commit = v.description;
                    }
                    stagesInfo[stagename].functions.push(finfo);
                }
            }
        }
    }

    for(const [stageKey,stageEntry] of Object.entries(stagesInfo) ) {
        let commits = Object.keys(stageEntry.commits);
        commits = commits.map(c=>c.split('-')[1]);
        if( commits.length === 1 ) {
            const commit = commits[0];
            console.log(`STAGE: ${stageKey} COMMIT: ${commit}`);
        }else if( commits.length > 1 ) {
            console.log(`STAGE: ${stageKey} COMMITS: ${commits.join(",")}`);
        }else{
            console.log(`STAGE: ${stageKey} NOT DEPLOYED`);
        }
        if( o.details ) {
            const functions = stageEntry.functions;
            for(const f of functions) {
                const funcName = f.name;
                const funcVersion = f.commit.includes('-')?f.commit.split('-')[1]:f.commit;
                console.log(`   - ${funcName} [${funcVersion}]`);
            }
            console.log();
        }
    }

    for(const topic of topics) {
        const subs = await sns.listSubscriptionsByTopic(topic.value);
        let commit = '';
        for(const sub of subs) {
            if( sub.protocol === 'lambda' ) {
                const parts = sub.endpoint.split(':');
                if( parts.length === 8 ) {
                    commit = parts[7].split('-')[1];
                    break;
                }
            }
        }
        if( commit ) {
            console.log(`TOPIC: ${topic.name} COMMIT: ${commit}`);
        }
    }

    console.log();
    console.timeEnd("api cicd");
}

main();