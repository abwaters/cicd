import { CICDPlugin } from './plugin';
import { getConfig } from './config';

let loaded: CICDPlugin[] | null = null;

function resolvePlugin(name: string): CICDPlugin {
    let mod: any;
    try {
        mod = require(name);
    } catch (e: any) {
        throw new Error(
            `Failed to load plugin '${name}': ${e.message}\n` +
            `  Install it with:  cicd install   (or: npm install ${name})`
        );
    }
    const plugin: CICDPlugin = mod && mod.default ? mod.default : mod;
    if (!plugin || typeof plugin !== 'object' || typeof plugin.name !== 'string') {
        throw new Error(`Plugin '${name}' does not export a valid CICDPlugin (missing 'name' field)`);
    }
    return plugin;
}

export async function loadPlugins(): Promise<CICDPlugin[]> {
    if (loaded) return loaded;
    const names = await getConfig('plugins');
    if (!Array.isArray(names) || names.length === 0) {
        loaded = [];
        return loaded;
    }
    const result: CICDPlugin[] = [];
    const seen = new Set<string>();
    for (const name of names) {
        const p = resolvePlugin(name);
        if (seen.has(p.name)) {
            throw new Error(`Duplicate plugin name '${p.name}' (from '${name}')`);
        }
        seen.add(p.name);
        result.push(p);
    }
    loaded = result;
    return loaded;
}

export function getPlugins(): CICDPlugin[] {
    if (!loaded) {
        throw new Error('Plugins not loaded — call loadPlugins() first');
    }
    return loaded;
}

export function resetPluginsForTest(): void {
    loaded = null;
}

export function loadPluginsSync(names: string[]): CICDPlugin[] {
    const result: CICDPlugin[] = [];
    const seen = new Set<string>();
    for (const name of names) {
        const p = resolvePlugin(name);
        if (seen.has(p.name)) {
            throw new Error(`Duplicate plugin name '${p.name}' (from '${name}')`);
        }
        seen.add(p.name);
        result.push(p);
    }
    return result;
}
