import { ExportConfig } from './types';

import * as cicd from './shared/cicd';
import * as options from './shared/options';
import * as credentials from './shared/credentials';
import * as logger from './shared/logger';
import * as cloudfront from './shared/cloudfront';
import { printHeader } from './shared/header';

async function main(): Promise<void> {
    await credentials.validateCredentials();

    let args = process.argv.slice(2);
    const o = options.getOptions(args);
    args = options.stripOptions(args);

    if (o.verbose) {
        logger.setVerbose(true);
        logger.log('Verbose mode enabled');
    }

    if (args.length < 1) {
        console.log(`invalidate <stage> [path...]`);
        console.log(`  Options: --web-filter=<name>, --verbose`);
        console.log(`  Default path: /*`);
        process.exit(0);
    }

    const stage = args[0];
    const paths = args.length > 1 ? args.slice(1) : ['/*'];

    await cicd.setStageConfig(stage);

    if (!o.noHeader) printHeader();

    const webFilter = (o.webFilter as string) || undefined;
    const webExports: ExportConfig[] = await cicd.getExportsByType('web', webFilter);
    const targets = webExports.filter(w => !w.stages || w.stages.includes(stage));

    if (targets.length === 0) {
        console.log(`No web exports configured for stage '${stage}'${webFilter ? ` matching filter '${webFilter}'` : ''}.`);
        process.exit(0);
    }

    console.time('cicd');
    console.log(`Creating invalidations on '${stage}' for paths: ${paths.join(', ')}`);

    for (const w of targets) {
        const distribution = w.distributionValue!;
        const id = await cloudfront.createInvalidation(distribution, paths);
        console.log(`  ${w.name.padEnd(40)} ${distribution.padEnd(20)} invalidation ${id}`);
    }

    console.log();
    console.timeEnd('cicd');
}

main().catch(err => {
    console.error(`\nInvalidation failed: ${err.message || err}`);
    process.exit(1);
});
