#!/usr/bin/env node

const Ajv = require('ajv');
const fs = require('fs');
const path = require('path');
const options = require('./shared/options');
const logger = require('./shared/logger');
const { printHeader } = require('./shared/header');

/**
 * Validates cicd.json against cicd.schema.json
 */
async function main() {
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

    // Validate
    const valid = validate(config);

    if (valid) {
      console.log('✓ cicd.json is valid');
      return true;
    } else {
      console.error('✗ cicd.json validation failed:\n');

      validate.errors.forEach((error) => {
        const path = error.instancePath || 'root';
        console.error(`  ${path}: ${error.message}`);

        if (error.params) {
          Object.entries(error.params).forEach(([key, value]) => {
            console.error(`    ${key}: ${JSON.stringify(value)}`);
          });
        }
      });

      process.exit(1);
    }
  } catch (error) {
    console.error('Error validating configuration:', error.message);
    process.exit(1);
  }
}

main();
