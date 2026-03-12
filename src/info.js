const options = require('./shared/options');
const cicd = require('./shared/cicd');
const lambda = require('./shared/lambda');
const apigw = require('./shared/apigw');
const sns = require('./shared/sns');
const twilio = require('./shared/twilio');
const credentials = require('./shared/credentials');
const logger = require('./shared/logger');
const { printHeader } = require('./shared/header');

async function main() {
    // Validate AWS credentials before proceeding
    await credentials.validateCredentials();

    const account = await cicd.getConfig("account");
    const region = await cicd.getConfig("region");
    let args = process.argv.slice(2);
    const o = options.getOptions(args);
    args = options.stripOptions(args);

    // Set verbose mode if requested
    if (o.verbose) {
        logger.setVerbose(true);
        logger.log('Verbose mode enabled');
    }

    console.time("api cicd");
    if (!o.noHeader) printHeader();
    console.log(`Collecting information for stages...`);
    const stages = await cicd.getConfig("stages");
    const apis = await cicd.getExportsByType('api');
    const topics = await cicd.getExportsByType('sns');
    const topicFunctions = await cicd.getLambdaExports('sns');
    const apiFunctions = await cicd.getLambdaExports('api');
    const functions = [...apiFunctions,...topicFunctions];
    const stagesInfo = {}, funcAliases = new Map(), funcVersions = new Map() ;
    for(const stage of stages) {
        stagesInfo[stage.stage] = {
            name: stage.stage,
            commits: {},
            details: [],
        }
    }

    for(const api of apis) {
        const apiId = api.value;
        logger.verbose(`   - Checking api ${api.name} [${apiId}]`);
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

    // Collect SNS topic results
    const topicResults = [];
    for(const topic of topics) {
        const subs = await sns.listSubscriptionsByTopic(topic.value);
        let commit = '';
        for(const sub of subs) {
            if( sub.protocol === 'lambda' ) {
                const parts = sub.endpoint.split(':');
                if( parts.length === 8 ) {
                    commit = parts[7].split('-')[1];
                    logger.verbose(`   - Topic ${topic.name} subscribed to alias '${parts[7]}'`);
                    break;
                }
            }
        }
        topicResults.push({ name: topic.name, commit: commit || null });
    }

    // ── Print summary ─────────────────────────────────────────────────

    // Stages
    console.log(`\nStages:`);
    for(const [stageKey,stageEntry] of Object.entries(stagesInfo) ) {
        let commits = Object.keys(stageEntry.commits);
        commits = commits.map(c=>c.split('-')[1]);
        if( commits.length === 1 ) {
            console.log(`  ${stageKey.padEnd(15)} ${commits[0]}`);
        }else if( commits.length > 1 ) {
            console.log(`  ${stageKey.padEnd(15)} ${commits.join(', ')}`);
        }else{
            console.log(`  ${stageKey.padEnd(15)} not deployed`);
        }
        if( o.details ) {
            const functions = stageEntry.functions;
            for(const f of functions) {
                const funcName = f.name;
                const funcVersion = f.commit.includes('-')?f.commit.split('-')[1]:f.commit;
                console.log(`    - ${funcName.padEnd(35)} ${funcVersion}`);
            }
        }
    }

    // SNS Topics
    if (topicResults.length > 0) {
        console.log(`\nSNS Topics:`);
        for (const r of topicResults) {
            console.log(`  ${r.name.padEnd(45)} ${r.commit || 'none'}`);
        }
    }

    // Twilio Phone Numbers
    const twilioResults = [];
    for (const stage of stages) {
        if (stage.twilio) {
            const accountSid = await cicd.getVar('TWILIO_ACCOUNT_SID').catch(() => null);
            const authToken = await cicd.getVar('TWILIO_AUTH_TOKEN').catch(() => null);
            if (accountSid && authToken) {
                try {
                    const phone = await twilio.getPhoneNumber(accountSid, authToken, stage.twilio.phoneNumberSid);
                    twilioResults.push({ stage: stage.stage, phoneNumber: phone.phoneNumber, smsUrl: phone.smsUrl });
                } catch (e) {
                    twilioResults.push({ stage: stage.stage, phoneNumber: stage.twilio.phoneNumberSid, smsUrl: 'error fetching' });
                }
            }
        }
    }
    if (twilioResults.length > 0) {
        console.log(`\nTwilio Phone Numbers:`);
        for (const r of twilioResults) {
            console.log(`  ${r.stage.padEnd(15)} ${r.phoneNumber.padEnd(20)} ${r.smsUrl}`);
        }
    }

    console.log();
    console.timeEnd("api cicd");
}

main();
