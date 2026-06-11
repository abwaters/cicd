#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';

import * as options from './shared/options';
import * as logger from './shared/logger';
import { printHeader } from './shared/header';

async function main(): Promise<void> {
    try {
        const args = process.argv.slice(2);
        const o = options.getOptions(args);
        options.enforceKnownOptions(o, 'install', []);

        if (o.verbose) {
            logger.setVerbose(true);
            logger.log('Verbose mode enabled');
        }

        if (!o.noHeader) printHeader();

        const configPath = path.join(process.cwd(), 'cicd.json');
        if (!fs.existsSync(configPath)) {
            console.error(`✗ cicd.json not found in ${process.cwd()}`);
            process.exit(1);
        }

        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        const pluginNames: string[] = Array.isArray(config.plugins) ? config.plugins : [];

        if (pluginNames.length === 0) {
            console.log('No plugins listed in cicd.json — nothing to install.');
            return;
        }

        // Allow only valid npm package name characters to prevent any chance of
        // shell-metacharacter injection when we hand the names to `npm install`.
        const SAFE_NAME = /^(@[a-zA-Z0-9._~-]+\/)?[a-zA-Z0-9._~-]+$/;

        const missing: string[] = [];
        for (const name of pluginNames) {
            if (!SAFE_NAME.test(name)) {
                console.error(`✗ Plugin name '${name}' contains invalid characters; refusing to install.`);
                process.exit(1);
            }
            try {
                require.resolve(name, { paths: [process.cwd()] });
                logger.verbose(`✓ ${name} already installed`);
            } catch {
                logger.verbose(`✗ ${name} not found`);
                missing.push(name);
            }
        }

        if (missing.length === 0) {
            console.log(`✓ All ${pluginNames.length} plugin(s) already installed.`);
            return;
        }

        console.log(`Installing ${missing.length} missing plugin(s):`);
        for (const m of missing) console.log(`  - ${m}`);
        console.log();

        const npmArgs = ['install', '--save-dev', ...missing];
        logger.verbose(`Running: npm ${npmArgs.join(' ')}`);
        // shell:true is needed on Windows so spawn can resolve npm.cmd via PATHEXT.
        // Safe here because plugin names are validated against SAFE_NAME above.
        const result = spawnSync('npm', npmArgs, {
            cwd: process.cwd(),
            stdio: 'inherit',
            shell: process.platform === 'win32',
        });

        if (result.status !== 0) {
            console.error(`\n✗ npm install failed (exit code ${result.status})`);
            process.exit(result.status ?? 1);
        }

        console.log(`\n✓ Installed ${missing.length} plugin(s).`);
    } catch (error: any) {
        console.error('Error installing plugins:', error.message);
        process.exit(1);
    }
}

main();
