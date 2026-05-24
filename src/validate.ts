import * as fs from 'fs';
import * as path from 'path';
import Ajv, { ErrorObject } from 'ajv';
import { CICDConfig } from './types';

import * as options from './shared/options';
import * as logger from './shared/logger';
import * as cicd from './shared/cicd';
import * as awsContext from './shared/aws-context';
import { printHeader } from './shared/header';
import { semanticValidation } from './shared/semantic';
import { loadPluginsSync } from './shared/plugins';
import { pluginConfigKey, CICDPlugin } from './shared/plugin';

// Names of plugin-owned stage-config keys that previously lived in the core
// schema. If validation fails with an `additionalProperties` violation on one
// of these keys and the user hasn't enabled the corresponding plugin, surface a
// targeted hint instead of the raw AJV error.
const EXTRACTED_PLUGIN_KEYS: Record<string, string> = {
    twilio: '@abwaters/cicd-plugin-twilio',
};

function mergePluginSchemas(schema: any, plugins: CICDPlugin[]): void {
    // Add top-level `plugins` field so users can list their plugins
    if (schema.properties && !schema.properties.plugins) {
        schema.properties.plugins = {
            type: 'array',
            description: 'Plugin module names to load (e.g., @abwaters/cicd-plugin-twilio)',
            items: { type: 'string', minLength: 1 },
        };
    }
    // Merge each plugin's stageSchema under stages[].<configKey>
    const stagesItemsProps = schema?.properties?.stages?.items?.properties;
    if (!stagesItemsProps) return;
    for (const p of plugins) {
        if (!p.stageSchema) continue;
        const key = pluginConfigKey(p);
        stagesItemsProps[key] = p.stageSchema;
    }
}

function formatErrorWithHint(error: ErrorObject, pluginsListed: Set<string>): string | null {
    if (error.keyword !== 'additionalProperties') return null;
    const extraKey = (error.params as any)?.additionalProperty;
    if (!extraKey || !EXTRACTED_PLUGIN_KEYS[extraKey]) return null;
    const pkg = EXTRACTED_PLUGIN_KEYS[extraKey];
    if (pluginsListed.has(pkg)) return null;
    return (
        `  ${error.instancePath || 'root'}: '${extraKey}' was moved out of core into the '${pkg}' plugin.\n` +
        `    To use it: npm install ${pkg}\n` +
        `    Then add to cicd.json:  "plugins": ["${pkg}"]`
    );
}

async function main(): Promise<void> {
  try {
    // Parse options
    const args = process.argv.slice(2);
    const o = options.getOptions(args);

    // Set verbose mode if requested
    if (o.verbose) {
        logger.setVerbose(true);
        logger.log('Verbose mode enabled');
    }

    if (!o.noHeader) printHeader();

    // Load schema
    const schemaPath = path.join(__dirname, '..', 'cicd.schema.json');
    const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
    logger.verbose('Loaded schema from:', schemaPath);

    // Load config from the user's cwd, not cicd's install dir (so this works
    // when cicd is installed globally and run from a project directory).
    const configPath = path.join(process.cwd(), 'cicd.json');
    if (!fs.existsSync(configPath)) {
        console.error(`✗ cicd.json not found in ${process.cwd()}`);
        process.exit(1);
    }
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    logger.verbose('Loaded config from:', configPath);

    // Load plugins listed in config and merge their schema fragments
    const pluginNames: string[] = Array.isArray(config.plugins) ? config.plugins : [];
    const pluginsListed = new Set(pluginNames);
    let plugins: CICDPlugin[] = [];
    if (pluginNames.length > 0) {
        try {
            plugins = loadPluginsSync(pluginNames);
        } catch (e: any) {
            console.error(`✗ Failed to load plugins: ${e.message}`);
            process.exit(1);
        }
        mergePluginSchemas(schema, plugins);
        logger.verbose(`Loaded ${plugins.length} plugin(s): ${plugins.map(p => p.name).join(', ')}`);
    } else {
        // Even without plugins, register the top-level `plugins` key so an empty array validates
        mergePluginSchemas(schema, []);
    }

    // Create validator
    const ajv = new Ajv({ allErrors: true, verbose: true });
    const validate = ajv.compile(schema);

    // Schema validation
    const valid = validate(config);

    if (!valid) {
      console.error('✗ cicd.json schema validation failed:\n');

      (validate.errors as ErrorObject[]).forEach((error) => {
        const hint = formatErrorWithHint(error, pluginsListed);
        if (hint) {
            console.error(hint);
            return;
        }
        const errorPath = error.instancePath || 'root';
        console.error(`  ${errorPath}: ${error.message}`);

        if (error.params) {
          Object.entries(error.params).forEach(([key, value]) => {
            console.error(`    ${key}: ${JSON.stringify(value)}`);
          });
        }
      });

      process.exit(1);
    }

    // Semantic validation
    const semanticErrors = semanticValidation(config as CICDConfig);
    if (semanticErrors.length > 0) {
      console.error('✗ cicd.json semantic validation failed:\n');
      for (const err of semanticErrors) {
        console.error(`  ${err}`);
      }
      process.exit(1);
    }

    // Variable resolution — resolves every !ImportValue, !SetEnv, and
    // !ParameterStore reference across global and per-stage environment.
    // Requires AWS credentials. Skipped with --skip-aws (shape-only check).
    if (o.skipAws) {
      logger.verbose('Skipping variable resolution (--skip-aws)');
      console.log('✓ cicd.json is valid (shape only — variable resolution skipped)');
      return;
    }

    // Resolve region + account via the fallback chain. getAccount() also
    // enforces the account-pin safety check (cicd.json "account" must match
    // the credentials' actual account if pinned).
    let region: string;
    let account: string;
    try {
      region = await awsContext.getRegion();
      account = await awsContext.getAccount();
    } catch (e: any) {
      const msg = e?.message || String(e);
      if (/Could not load credentials|Unable to load credentials|CredentialsProviderError/i.test(msg)) {
        console.error(`✗ Cannot validate variable references: AWS credentials are not configured.\n`);
        console.error('  Set AWS_PROFILE, AWS_ACCESS_KEY_ID, or configure ~/.aws/credentials.');
        console.error('  Or re-run with --skip-aws to validate shape only.');
        process.exit(1);
      }
      if (/security token|not authorized|ExpiredToken|UnrecognizedClientException/i.test(msg)) {
        const profile = process.env.AWS_PROFILE ? ` (AWS_PROFILE=${process.env.AWS_PROFILE})` : '';
        console.error(`✗ Cannot validate variable references: AWS credentials are invalid or expired${profile}.`);
        console.error('  Re-run with --skip-aws to validate shape only.');
        process.exit(1);
      }
      // region-not-found, account-pin-mismatch, or any other resolution error
      console.error(`✗ ${msg}`);
      process.exit(1);
    }
    logger.verbose(`Resolved AWS context: account=${account}, region=${region}`);

    const varErrors = await cicd.validateAllVariables();
    if (varErrors.length > 0) {
      console.error(`✗ cicd.json variable resolution failed (${varErrors.length} issue${varErrors.length === 1 ? '' : 's'}):\n`);
      for (const err of varErrors) {
        console.error(`  ${err}`);
      }
      process.exit(1);
    }

    console.log('✓ cicd.json is valid');
  } catch (error: any) {
    console.error('Error validating configuration:', error.message);
    process.exit(1);
  }
}

main();
