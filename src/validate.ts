import * as fs from 'fs';
import * as path from 'path';
import Ajv, { ErrorObject } from 'ajv';
import { CICDConfig, ThrottleSettings } from './types';

const options = require('./shared/options');
const logger = require('./shared/logger');
const { printHeader } = require('./shared/header');

function semanticValidation(config: CICDConfig): string[] {
    const errors: string[] = [];
    const stageNames = new Set((config.stages || []).map(s => s.stage));

    // Validate throttle: burstLimit >= rateLimit
    function checkThrottle(throttle: ThrottleSettings | undefined, location: string): void {
        if (throttle && throttle.burstLimit < throttle.rateLimit) {
            errors.push(`${location}: burstLimit (${throttle.burstLimit}) must be >= rateLimit (${throttle.rateLimit})`);
        }
    }
    checkThrottle(config.throttle, 'global throttle');
    for (const stage of config.stages || []) {
        checkThrottle(stage.throttle, `stage '${stage.stage}' throttle`);
    }

    // Collect all environment variable names
    const envVarNames = new Set<string>();
    if (config.environment) {
        for (const key of Object.keys(config.environment)) {
            envVarNames.add(key);
        }
    }
    for (const stage of config.stages || []) {
        if (stage.environment) {
            for (const key of Object.keys(stage.environment)) {
                envVarNames.add(key);
            }
        }
    }

    const allFunctionNames = new Set<string>();

    for (const exp of config.exports || []) {
        // Validate API-level throttle
        if (exp.type === 'api') {
            checkThrottle(exp.throttle, `export '${exp.name}' throttle`);
        }

        // Validate SNS stages references
        if (exp.type === 'sns' && exp.stages) {
            for (const s of exp.stages) {
                if (!stageNames.has(s)) {
                    errors.push(`SNS export '${exp.name}' references undefined stage '${s}'`);
                }
            }
        }

        // Check for duplicate function names within a single export
        const exportFunctionNames = new Set<string>();
        for (const f of exp.functions || []) {
            if (exportFunctionNames.has(f.name)) {
                errors.push(`Duplicate function name '${f.name}' within export '${exp.name}'`);
            }
            exportFunctionNames.add(f.name);
            allFunctionNames.add(f.name);

            // Validate env var and group references exist
            if (f.env) {
                const vars = f.env.split(',').map(v => v.trim());
                for (const v of vars) {
                    if (v.startsWith('@')) {
                        const groupName = v.substring(1);
                        if (!config.environmentGroups || !config.environmentGroups[groupName]) {
                            errors.push(`Function '${f.name}' references undefined environment group '${groupName}'`);
                        } else {
                            // Validate group members exist in environment
                            for (const member of config.environmentGroups[groupName]) {
                                if (!envVarNames.has(member)) {
                                    errors.push(`Environment group '${groupName}' references undefined variable '${member}'`);
                                }
                            }
                        }
                    } else if (!envVarNames.has(v)) {
                        errors.push(`Function '${f.name}' references undefined environment variable '${v}'`);
                    }
                }
            }
        }
    }

    // Validate Fargate stages have service + taskFamily
    if (config.computeMode === 'fargate') {
        for (const stage of config.stages || []) {
            if (!stage.service) {
                errors.push(`Fargate stage '${stage.stage}' is missing required 'service'`);
            }
            if (!stage.taskFamily) {
                errors.push(`Fargate stage '${stage.stage}' is missing required 'taskFamily'`);
            }
        }
    }

    return errors;
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
