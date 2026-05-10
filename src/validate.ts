import * as fs from 'fs';
import * as path from 'path';
import Ajv, { ErrorObject } from 'ajv';
import { CICDConfig } from './types';

import * as options from './shared/options';
import * as logger from './shared/logger';
import { printHeader } from './shared/header';
import { semanticValidation } from './shared/semantic';

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

    // Load config
    const configPath = path.join(__dirname, '..', 'cicd.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    logger.verbose('Loaded config from:', configPath);

    // Create validator
    const ajv = new Ajv({ allErrors: true, verbose: true });
    const validate = ajv.compile(schema);

    // Schema validation
    const valid = validate(config);

    if (!valid) {
      console.error('✗ cicd.json schema validation failed:\n');

      (validate.errors as ErrorObject[]).forEach((error) => {
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

    console.log('✓ cicd.json is valid');
  } catch (error: any) {
    console.error('Error validating configuration:', error.message);
    process.exit(1);
  }
}

main();
