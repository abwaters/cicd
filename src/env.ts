import * as cicd from './shared/cicd';
import * as options from './shared/options';
import * as credentials from './shared/credentials';
import * as logger from './shared/logger';
import { printHeader } from './shared/header';
import { StageConfig } from './types';

async function main(): Promise<void> {
    await credentials.validateCredentials();

    let args = process.argv.slice(2);
    const o = options.getOptions(args);
    options.enforceKnownOptions(o, 'env', ['linux', 'powershell']);
    args = options.stripOptions(args);

    if (o.verbose) {
        logger.setVerbose(true);
    }

    if (args.length < 1) {
        console.log(`env <stage> [options]

Options:
  --linux       Output export statements (Linux/macOS)
  --powershell  Output $env: statements (PowerShell)
                Default: set statements (Windows CMD)`);
        process.exit(0);
    }

    const stage = args[0];

    await cicd.setStageConfig(stage);

    if (!o.noHeader) printHeader();

    // Collect all environment variable keys from global + stage config
    const globalEnv: Record<string, string> = (await cicd.getConfig('environment')) ?? {};
    const stages: StageConfig[] = await cicd.getConfig('stages');
    const stageEntry = stages.find(s => s.stage === stage);

    if (!stageEntry) {
        console.error(`Error: Stage '${stage}' not found in cicd.json`);
        process.exit(1);
    }

    const stageEnv: Record<string, string> = stageEntry.environment ?? {};
    const allKeys = [...new Set([...Object.keys(globalEnv), ...Object.keys(stageEnv)])].sort();

    // Resolve all values
    const resolved: Array<{ key: string; value: string }> = [];
    for (const key of allKeys) {
        const value = await cicd.getVar(key);
        resolved.push({ key, value });
    }

    // Determine output format
    const format = o.linux ? 'linux' : o.powershell ? 'powershell' : 'windows';

    console.log(`# Environment variables for stage: ${stage}`);
    console.log(`# ${resolved.length} variables resolved`);
    console.log();

    for (const { key, value } of resolved) {
        switch (format) {
            case 'linux':
                console.log(`export ${key}="${escapeForShell(value)}"`);
                break;
            case 'powershell':
                console.log(`$env:${key}="${escapeForPowershell(value)}"`);
                break;
            default:
                console.log(`set ${key}=${value}`);
                break;
        }
    }
}

function escapeForShell(value: string): string {
    return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '\\$');
}

function escapeForPowershell(value: string): string {
    return value.replace(/"/g, '`"').replace(/\$/g, '`$');
}

main().catch(err => {
    console.error(`\nError: ${err.message || err}`);
    process.exit(1);
});
