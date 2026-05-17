import * as fs from 'fs';
import { execSync } from 'child_process';
import { CICDConfig } from '../types';

let rawConfig: CICDConfig | null = null;

function inferRepoFromGit(): string | undefined {
    try {
        const url = execSync('git config --get remote.origin.url', {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
        const m = url.match(/github\.com[:/]([^/]+)\/([^/.]+?)(?:\.git)?$/i);
        return m ? `${m[1]}/${m[2]}` : undefined;
    } catch {
        return undefined;
    }
}

async function initConfig(): Promise<void> {
    if( !rawConfig ) {
        const data = fs.readFileSync("./cicd.json",{encoding:"utf8"});
        rawConfig = JSON.parse(data);
        if (!rawConfig!.repo) {
            const inferred = inferRepoFromGit();
            if (inferred) rawConfig!.repo = inferred;
        }
    }
}

async function getConfig<T extends keyof CICDConfig>(key: T): Promise<CICDConfig[T]> {
    await initConfig();
    return rawConfig![key];
}

export { initConfig, getConfig };
