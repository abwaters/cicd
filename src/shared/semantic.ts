import { CICDConfig, ThrottleSettings } from '../types';
import { composeMappingPath } from './cicd';

// Semantic (cross-field) validation of cicd.json. Schema validation handles
// shape; this enforces references, uniqueness, and computed-path collisions
// that JSON Schema can't express.
export function semanticValidation(config: CICDConfig): string[] {
    const errors: string[] = [];
    const stageNames = new Set((config.stages || []).map(s => s.stage));

    function checkThrottle(throttle: ThrottleSettings | undefined, location: string): void {
        if (throttle && throttle.burstLimit < throttle.rateLimit) {
            errors.push(`${location}: burstLimit (${throttle.burstLimit}) must be >= rateLimit (${throttle.rateLimit})`);
        }
    }
    checkThrottle(config.throttle, 'global throttle');
    for (const stage of config.stages || []) {
        checkThrottle(stage.throttle, `stage '${stage.stage}' throttle`);
    }

    const envVarNames = new Set<string>();
    if (config.environment) {
        for (const key of Object.keys(config.environment)) envVarNames.add(key);
    }
    for (const stage of config.stages || []) {
        if (stage.environment) {
            for (const key of Object.keys(stage.environment)) envVarNames.add(key);
        }
    }

    const allFunctionNames = new Set<string>();
    for (const exp of config.exports || []) {
        if (exp.type === 'api') {
            checkThrottle(exp.throttle, `export '${exp.name}' throttle`);
        }
        if (exp.type === 'sns' && exp.stages) {
            for (const s of exp.stages) {
                if (!stageNames.has(s)) {
                    errors.push(`SNS export '${exp.name}' references undefined stage '${s}'`);
                }
            }
        }
        if (exp.type === 'sqs' && exp.stages) {
            for (const s of exp.stages) {
                if (!stageNames.has(s)) {
                    errors.push(`SQS export '${exp.name}' references undefined stage '${s}'`);
                }
            }
        }

        const exportFunctionNames = new Set<string>();
        for (const f of exp.functions || []) {
            if (exportFunctionNames.has(f.name)) {
                errors.push(`Duplicate function name '${f.name}' within export '${exp.name}'`);
            }
            exportFunctionNames.add(f.name);
            allFunctionNames.add(f.name);

            if (f.env) {
                const vars = f.env.split(',').map(v => v.trim());
                for (const v of vars) {
                    if (v.startsWith('@')) {
                        const groupName = v.substring(1);
                        if (!config.environmentGroups || !config.environmentGroups[groupName]) {
                            errors.push(`Function '${f.name}' references undefined environment group '${groupName}'`);
                        } else {
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

    // API mapping path collision: two APIs that resolve to the same final path
    // on the same custom domain in the same stage cannot both be deployed.
    const apiExports = (config.exports || []).filter(e => e.type === 'api');
    for (const stage of config.stages || []) {
        if (!stage.mapping) continue;
        const seen = new Map<string, string>();
        for (const api of apiExports) {
            const composed = composeMappingPath(stage, api);
            const key = `${stage.mapping.domain}|${composed}`;
            if (seen.has(key)) {
                errors.push(
                    `Stage '${stage.stage}': APIs '${seen.get(key)}' and '${api.name}' both resolve to '${stage.mapping.domain}/${composed}'`
                );
            } else {
                seen.set(key, api.name);
            }
        }
    }

    return errors;
}
