import * as fs from 'fs';
import { CICDConfig } from '../types';

let rawConfig: CICDConfig | null = null;

async function initConfig(): Promise<void> {
    if( !rawConfig ) {
        const data = fs.readFileSync("./cicd.json",{encoding:"utf8"});
        rawConfig = JSON.parse(data);
    }
}

async function getConfig<T extends keyof CICDConfig>(key: T): Promise<CICDConfig[T]> {
    await initConfig();
    return rawConfig![key];
}

module.exports = {initConfig,getConfig};
