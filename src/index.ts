#!/usr/bin/env node

// Command table: module to load and the failure prefix used when an error
// escapes the command. Exit codes are owned here, not by the commands.
const COMMANDS: Record<string, { module: string; failLabel: string }> = {
    deploy:     { module: './deploy',     failLabel: 'Deployment failed' },
    clean:      { module: './clean',      failLabel: 'Clean failed' },
    info:       { module: './info',       failLabel: 'Error' },
    validate:   { module: './validate',   failLabel: 'Error validating configuration' },
    rollback:   { module: './rollback',   failLabel: 'Rollback failed' },
    restart:    { module: './restart',    failLabel: 'Restart failed' },
    env:        { module: './env',        failLabel: 'Error' },
    invalidate: { module: './invalidate', failLabel: 'Invalidation failed' },
    cloudfront: { module: './cloudfront', failLabel: 'CloudFront config generation failed' },
    install:    { module: './install',    failLabel: 'Error installing plugins' },
};

async function main(): Promise<void> {
    const args = process.argv.slice(2);

    if (args.length === 0) {
        showUsage();
        process.exit(0);
    }

    const command = args[0];
    const commandArgs = args.slice(1);

    // Handle help flags
    if (command === 'help' || command === '--help' || command === '-h') {
        showUsage();
        process.exit(0);
    }

    const def = COMMANDS[command];
    if (!def) {
        console.error(`Error: Unknown command '${command}'\n`);
        showUsage();
        process.exit(1);
    }

    // Override process.argv to pass remaining args to subcommands
    process.argv = [process.argv[0], process.argv[1], ...commandArgs];

    try {
        await require(def.module).run();
    } catch (error: any) {
        // Credential errors carry their own multi-line remediation text.
        if (error?.name === 'CredentialsError') {
            console.error(`\nError: ${error.message}`);
        } else {
            console.error(`\n${def.failLabel}: ${error?.message || error}`);
        }
        process.exit(1);
    }
}

function showUsage(): void {
    const cmd = require.main === module ? 'cicd' : 'node src/index.js';
    console.log(`Usage: ${cmd} <command> [options]

Commands:
  deploy <stage> <commit>     Deploy a commit to a stage
                              Options: --env, --api, --sns, --sqs, --workers, --web,
                                       --api-filter=<name>, --web-filter=<name>, --verbose

  clean                       Clean up unused API deployments, Lambda aliases/versions
                              Options: --verbose

  info [options]              Show current deployments for all stages
                              Options: --verbose, --no-header

  rollback <stage> [commit]   Rollback a stage to a previous deployment
                              Options: --env, --api, --sns, --sqs, --workers, --web,
                                       --api-filter=<name>, --web-filter=<name>, --verbose

  restart <stage>             Force restart a Fargate service (fargate mode only)
                              Options: --no-wait, --verbose

  env <stage>                 Output resolved environment variables for a stage
                              Options: --linux, --powershell, --verbose
                              Default format: Windows CMD (set KEY=VALUE)

  invalidate <stage> [paths]  Create CloudFront invalidations for web exports on a stage
                              Options: --web-filter=<name>, --verbose
                              Default path: /*

  cloudfront <stage>          Generate the CloudFormation Origin + CacheBehavior for a
                              CloudFront-mapped stage (paste into your template once)
                              Options: --json, --api-filter=<name>, --verbose

  install                     Install any plugins listed in cicd.json that are
                              missing from node_modules (npm install --save-dev)
                              Options: --verbose

  validate                    Validate cicd.json against schema, then resolve
                              every !ImportValue / !SetEnv / !ParameterStore
                              reference (requires AWS credentials)
                              Options: --skip-aws, --verbose

Global Options:
  --verbose                   Enable verbose logging for debugging

Examples:
  ${cmd} deploy dev abc123
  ${cmd} deploy prod abc123 --api
  ${cmd} deploy staging abc123 --verbose
  ${cmd} clean --verbose
  ${cmd} info --verbose
  ${cmd} validate
`);
}

void main();
