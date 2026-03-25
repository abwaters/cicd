#!/usr/bin/env node

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

    // Override process.argv to pass remaining args to subcommands
    process.argv = [process.argv[0], process.argv[1], ...commandArgs];

    try {
        switch (command) {
            case 'deploy':
                require('./deploy');
                break;
            case 'clean':
                require('./clean');
                break;
            case 'info':
                require('./info');
                break;
            case 'validate':
                require('./validate');
                break;
            case 'rollback':
                require('./rollback');
                break;
            case 'restart':
                require('./restart');
                break;
            default:
                console.error(`Error: Unknown command '${command}'\n`);
                showUsage();
                process.exit(1);
        }
    } catch (error: any) {
        console.error(`Error executing command '${command}':`, error.message);
        process.exit(1);
    }
}

function showUsage(): void {
    const cmd = require.main === module ? 'cicd' : 'node src/index.js';
    console.log(`Usage: ${cmd} <command> [options]

Commands:
  deploy <stage> <commit>     Deploy a commit to a stage
                              Options: --env, --api, --sns, --api-filter=<name>, --verbose

  clean                       Clean up unused API deployments, Lambda aliases/versions
                              Options: --verbose

  info [options]              Show current deployments for all stages
                              Options: --details, --verbose

  rollback <stage> [commit]   Rollback a stage to a previous deployment
                              Options: --env, --api, --sns, --api-filter=<name>, --verbose

  restart <stage>             Force restart a Fargate service (fargate mode only)
                              Options: --no-wait, --verbose

  validate                    Validate cicd.json against schema
                              Options: --verbose

Global Options:
  --verbose                   Enable verbose logging for debugging

Examples:
  ${cmd} deploy dev abc123
  ${cmd} deploy prod abc123 --api
  ${cmd} deploy staging abc123 --verbose
  ${cmd} clean --verbose
  ${cmd} info --details
  ${cmd} validate
`);
}

main();
