#!/usr/bin/env node

const path = require('path');

async function main() {
    const args = process.argv.slice(2);

    if (args.length === 0) {
        showUsage();
        process.exit(0);
    }

    const command = args[0];
    const commandArgs = args.slice(1);

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
            default:
                console.error(`Error: Unknown command '${command}'\n`);
                showUsage();
                process.exit(1);
        }
    } catch (error) {
        console.error(`Error executing command '${command}':`, error.message);
        process.exit(1);
    }
}

function showUsage() {
    console.log(`Usage: node src/index.js <command> [options]

Commands:
  deploy <stage> <commit>     Deploy a commit to a stage
                              Options: --env, --api, --sns, --api-filter=<name>

  clean                       Clean up unused API deployments, Lambda aliases/versions

  info [options]              Show current deployments for all stages
                              Options: --details

  validate                    Validate cicd.json against schema

Examples:
  node src/index.js deploy dev abc123
  node src/index.js deploy prod abc123 --api
  node src/index.js clean
  node src/index.js info --details
  node src/index.js validate
`);
}

main();
