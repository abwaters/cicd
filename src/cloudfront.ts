import { ExportConfig } from './types';

import * as cicd from './shared/cicd';
import * as options from './shared/options';
import * as credentials from './shared/credentials';
import * as awsContext from './shared/aws-context';
import * as logger from './shared/logger';
import { buildCloudFrontFragment, CfnApi } from './shared/cfn-cloudfront';
import { printHeader } from './shared/header';

// `cicd cloudfront <stage> [--json] [--api-filter=<name>]`
// Prints the CloudFormation Origin + CacheBehavior fragment a stage's CloudFront
// distribution needs so its API Gateway REST APIs are served at the configured
// path prefix (e.g. /api/*). cicd never mutates the distribution — this is the
// config you paste into CloudFormation once, before the first CloudFront deploy.
async function main(): Promise<void> {
    await credentials.validateCredentials();

    let args = process.argv.slice(2);
    const o = options.getOptions(args);
    options.enforceKnownOptions(o, 'cloudfront', ['apiFilter', 'json']);
    args = options.stripOptions(args);

    if (o.verbose) {
        logger.setVerbose(true);
        logger.log('Verbose mode enabled');
    }

    if (args.length < 1) {
        console.log(`cloudfront <stage>`);
        console.log(`  Generate the CloudFormation Origin + CacheBehavior for a CloudFront-mapped stage`);
        console.log(`  Options: --json, --api-filter=<name>, --verbose`);
        process.exit(0);
    }

    const stage = args[0];
    await cicd.setStageConfig(stage);
    const stageConfig = await cicd.getCurrentStageConfig();

    if (!stageConfig.cloudfront) {
        console.error(`Stage '${stage}' has no 'cloudfront' mapping configured in cicd.json.`);
        process.exit(1);
    }
    const cf = stageConfig.cloudfront;

    const apiFilter = (o.apiFilter as string) || undefined;
    const apis: ExportConfig[] = await cicd.getExportsByType('api', apiFilter);
    if (apis.length === 0) {
        console.error(`No API exports configured${apiFilter ? ` matching filter '${apiFilter}'` : ''}.`);
        process.exit(1);
    }

    const region = await awsContext.getRegion();
    const format: 'yaml' | 'json' = o.json ? 'json' : 'yaml';

    if (!o.noHeader && !o.json) printHeader();

    const cfnApis: CfnApi[] = apis.map(api => ({
        name: api.name,
        apiId: api.value!,
        region,
        pathPattern: `/${cicd.composeCloudFrontPath(cf, api)}/*`,
        exportName: api.name
    }));

    const fragment = buildCloudFrontFragment({ stage, apis: cfnApis, cachePolicy: cf.cachePolicy, format });
    console.log(fragment);
}

export { main as run };
