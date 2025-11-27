#!/usr/bin/env node

const Ajv = require('ajv');
const fs = require('fs');
const path = require('path');

/**
 * Validates cicd.json against cicd.schema.json
 */
async function validate() {
  try {
    // Load schema
    const schemaPath = path.join(__dirname, '..', 'cicd.schema.json');
    const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));

    // Load config
    const configPath = path.join(__dirname, '..', 'cicd.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

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

// Run validation if called directly
if (require.main === module) {
  validate();
}

module.exports = { validate };
