import { semanticValidation } from '../src/shared/semantic';
import { CICDConfig } from '../src/types';

function baseConfig(overrides: Partial<CICDConfig> = {}): CICDConfig {
    return {
        app: 'myapp',
        account: '123456789012',
        region: 'us-east-1',
        exports: [],
        stages: [{ stage: 'dev' } as any],
        ...overrides,
    };
}

describe('semanticValidation - throttle', () => {
    it('flags global throttle with burst < rate', () => {
        const errors = semanticValidation(baseConfig({
            throttle: { rateLimit: 100, burstLimit: 50 },
        }));
        expect(errors).toContain('global throttle: burstLimit (50) must be >= rateLimit (100)');
    });

    it('accepts global throttle with burst >= rate', () => {
        const errors = semanticValidation(baseConfig({
            throttle: { rateLimit: 100, burstLimit: 200 },
        }));
        expect(errors).toHaveLength(0);
    });

    it('flags stage-level throttle violations', () => {
        const errors = semanticValidation(baseConfig({
            stages: [{ stage: 'dev', throttle: { rateLimit: 100, burstLimit: 50 } } as any],
        }));
        expect(errors).toContain("stage 'dev' throttle: burstLimit (50) must be >= rateLimit (100)");
    });

    it('flags export-level api throttle violations', () => {
        const errors = semanticValidation(baseConfig({
            exports: [{
                type: 'api', name: 'a',
                throttle: { rateLimit: 100, burstLimit: 50 },
            }],
        }));
        expect(errors).toContain("export 'a' throttle: burstLimit (50) must be >= rateLimit (100)");
    });
});

describe('semanticValidation - stage references', () => {
    it('flags SNS export referencing undefined stage', () => {
        const errors = semanticValidation(baseConfig({
            exports: [{ type: 'sns', name: 't1', stages: ['dev', 'ghost'] }],
        }));
        expect(errors).toContain("SNS export 't1' references undefined stage 'ghost'");
    });

    it('flags SQS export referencing undefined stage', () => {
        const errors = semanticValidation(baseConfig({
            exports: [{ type: 'sqs', name: 'q1', stages: ['ghost'] }],
        }));
        expect(errors).toContain("SQS export 'q1' references undefined stage 'ghost'");
    });

    it('passes when all referenced stages exist', () => {
        const errors = semanticValidation(baseConfig({
            stages: [{ stage: 'dev' } as any, { stage: 'prod' } as any],
            exports: [{ type: 'sns', name: 't1', stages: ['dev', 'prod'] }],
        }));
        expect(errors).toHaveLength(0);
    });
});

describe('semanticValidation - duplicate function names', () => {
    it('flags duplicate function names within an export', () => {
        const errors = semanticValidation(baseConfig({
            exports: [{
                type: 'api', name: 'a',
                functions: [{ name: 'fn1' }, { name: 'fn1' }],
            }],
        }));
        expect(errors).toContain("Duplicate function name 'fn1' within export 'a'");
    });

    it('allows the same function name across different exports', () => {
        const errors = semanticValidation(baseConfig({
            exports: [
                { type: 'api', name: 'a', functions: [{ name: 'fn1' }] },
                { type: 'api', name: 'b', functions: [{ name: 'fn1' }] },
            ],
        }));
        expect(errors).toHaveLength(0);
    });
});

describe('semanticValidation - environment variable references', () => {
    it('flags undefined env var on a function', () => {
        const errors = semanticValidation(baseConfig({
            environment: { FOO: 'foo' },
            exports: [{
                type: 'api', name: 'a',
                functions: [{ name: 'fn1', env: 'FOO,MISSING' }],
            }],
        }));
        expect(errors).toContain("Function 'fn1' references undefined environment variable 'MISSING'");
    });

    it('accepts env vars defined globally OR per-stage', () => {
        const errors = semanticValidation(baseConfig({
            environment: { FOO: 'foo' },
            stages: [{ stage: 'dev', environment: { BAR: 'bar' } } as any],
            exports: [{
                type: 'api', name: 'a',
                functions: [{ name: 'fn1', env: 'FOO,BAR' }],
            }],
        }));
        expect(errors).toHaveLength(0);
    });

    it('flags undefined environment group reference', () => {
        const errors = semanticValidation(baseConfig({
            exports: [{
                type: 'api', name: 'a',
                functions: [{ name: 'fn1', env: '@missingGroup' }],
            }],
        }));
        expect(errors).toContain("Function 'fn1' references undefined environment group 'missingGroup'");
    });

    it('flags env group whose member is undefined', () => {
        const errors = semanticValidation(baseConfig({
            environment: { FOO: 'foo' },
            environmentGroups: { common: ['FOO', 'MISSING'] },
            exports: [{
                type: 'api', name: 'a',
                functions: [{ name: 'fn1', env: '@common' }],
            }],
        }));
        expect(errors).toContain("Environment group 'common' references undefined variable 'MISSING'");
    });
});

describe('semanticValidation - fargate', () => {
    it('flags missing service and taskFamily on fargate stages', () => {
        const errors = semanticValidation(baseConfig({
            computeMode: 'fargate',
            stages: [{ stage: 'dev' } as any],
        }));
        expect(errors).toContain("Fargate stage 'dev' is missing required 'service'");
        expect(errors).toContain("Fargate stage 'dev' is missing required 'taskFamily'");
    });

    it('passes when fargate stages have service + taskFamily', () => {
        const errors = semanticValidation(baseConfig({
            computeMode: 'fargate',
            stages: [{ stage: 'dev', service: 'svc', taskFamily: 'fam' } as any],
        }));
        expect(errors).toHaveLength(0);
    });

    it('does not require service/taskFamily on lambda stages', () => {
        const errors = semanticValidation(baseConfig({
            computeMode: 'lambda',
            stages: [{ stage: 'dev' } as any],
        }));
        expect(errors).toHaveLength(0);
    });
});

describe('semanticValidation - batch', () => {
    it('flags duplicate batch job names', () => {
        const errors = semanticValidation(baseConfig({
            computeMode: 'batch',
            batch: {
                jobQueue: '!ImportValue q',
                jobs: [
                    { name: 'reminders-morning', image: 'repo' },
                    { name: 'reminders-morning', image: 'repo' },
                ],
            },
            stages: [{ stage: 'prod' } as any],
        }));
        expect(errors).toContain("Duplicate batch job name 'reminders-morning'");
    });

    it('flags batch mode with no batch block', () => {
        const errors = semanticValidation(baseConfig({
            computeMode: 'batch',
            stages: [{ stage: 'prod' } as any],
        }));
        expect(errors).toContain("computeMode 'batch' requires a 'batch' configuration block");
    });

    it('passes a valid batch config', () => {
        const errors = semanticValidation(baseConfig({
            computeMode: 'batch',
            batch: {
                jobQueue: '!ImportValue q',
                executionRole: 'arn:aws:iam::123456789012:role/exec',
                jobs: [
                    { name: 'reminders-morning', image: 'repo', environment: { REMINDER_OFFSET: '0' } },
                    { name: 'reminders-evening', image: 'repo', environment: { REMINDER_OFFSET: '1' } },
                ],
            },
            stages: [{ stage: 'prod', production: true } as any],
        }));
        expect(errors).toHaveLength(0);
    });
});

describe('semanticValidation - api mapping path collisions', () => {
    it('flags two APIs that resolve to the same domain+path', () => {
        const errors = semanticValidation(baseConfig({
            stages: [{
                stage: 'dev',
                mapping: { domain: 'api.example.com', path: 'v1' },
            } as any],
            exports: [
                { type: 'api', name: 'a', prefix: 'auth' },
                { type: 'api', name: 'b', prefix: 'auth' },
            ],
        }));
        expect(errors).toContain(
            "Stage 'dev': APIs 'a' and 'b' both resolve to 'api.example.com/v1/auth'"
        );
    });

    it('does not flag distinct paths', () => {
        const errors = semanticValidation(baseConfig({
            stages: [{
                stage: 'dev',
                mapping: { domain: 'api.example.com', path: 'v1' },
            } as any],
            exports: [
                { type: 'api', name: 'a', prefix: 'auth' },
                { type: 'api', name: 'b', prefix: 'users' },
            ],
        }));
        expect(errors).toHaveLength(0);
    });

    it('skips stages without a mapping', () => {
        const errors = semanticValidation(baseConfig({
            stages: [{ stage: 'dev' } as any],
            exports: [
                { type: 'api', name: 'a', prefix: 'auth' },
                { type: 'api', name: 'b', prefix: 'auth' },
            ],
        }));
        expect(errors).toHaveLength(0);
    });
});

describe('semanticValidation - cloudfront path collisions', () => {
    it('flags two APIs that resolve to the same cloudfront path on a distribution', () => {
        const errors = semanticValidation(baseConfig({
            stages: [{
                stage: 'dev',
                cloudfront: { distribution: 'dist-export', path: 'api' },
            } as any],
            exports: [
                { type: 'api', name: 'a', prefix: 'auth' },
                { type: 'api', name: 'b', prefix: 'auth' },
            ],
        }));
        expect(errors).toContain(
            "Stage 'dev': APIs 'a' and 'b' both resolve to CloudFront path '/api/auth/*' on distribution 'dist-export'"
        );
    });

    it('does not flag distinct cloudfront paths', () => {
        const errors = semanticValidation(baseConfig({
            stages: [{
                stage: 'dev',
                cloudfront: { distribution: 'dist-export' },
            } as any],
            exports: [
                { type: 'api', name: 'a', path: 'orders' },
                { type: 'api', name: 'b', path: 'customers' },
            ],
        }));
        expect(errors).toHaveLength(0);
    });

    it('skips stages without a cloudfront mapping', () => {
        const errors = semanticValidation(baseConfig({
            stages: [{ stage: 'dev', mapping: { domain: 'd', path: '' } } as any],
            exports: [
                { type: 'api', name: 'a', path: 'orders' },
                { type: 'api', name: 'b', path: 'customers' },
            ],
        }));
        expect(errors).toHaveLength(0);
    });
});

describe('semanticValidation - clean config', () => {
    it('returns no errors for a fully valid minimal config', () => {
        const errors = semanticValidation(baseConfig());
        expect(errors).toEqual([]);
    });

    it('aggregates multiple errors', () => {
        const errors = semanticValidation(baseConfig({
            throttle: { rateLimit: 100, burstLimit: 50 },
            exports: [
                { type: 'api', name: 'a', functions: [{ name: 'fn1' }, { name: 'fn1' }] },
                { type: 'sns', name: 't1', stages: ['ghost'] },
            ],
        }));
        expect(errors.length).toBeGreaterThanOrEqual(3);
    });
});
