import * as fs from 'fs';
import * as path from 'path';
import Ajv from 'ajv';

const schema = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'cicd.schema.json'), 'utf8')
);

function compile() {
    const ajv = new Ajv({ allErrors: true });
    return ajv.compile(schema);
}

const validBatch = {
    app: 'ccfw-jobs',
    computeMode: 'batch',
    repo: 'abwaters/ccfw-jobs',
    batch: {
        jobQueue: '!ImportValue tcp3-low-priority-batch-queue',
        executionRole: 'arn:aws:iam::907688428238:role/ecsTaskExecutionRole',
        jobs: [
            {
                name: 'reminders-morning',
                image: '!ImportValue ccfw-reminders-repo-uri',
                jobRole: '!ImportValue ccfw-reminders-job-role-arn',
                vcpu: 1,
                memory: 1024,
                command: ['node', 'dist/jobs/reminders/index.js'],
                logGroup: '/ccfw/reminders',
                environment: { REMINDER_OFFSET: '0', DEBUG: 'false' },
            },
        ],
    },
    stages: [{ stage: 'prod', mapping: { domain: 'x', path: '' }, production: true }],
};

describe('cicd.schema.json - batch mode', () => {
    it('accepts a valid batch config', () => {
        const validate = compile();
        const ok = validate(validBatch);
        if (!ok) console.error(validate.errors);
        expect(ok).toBe(true);
    });

    it('requires a batch block when computeMode is batch', () => {
        const validate = compile();
        const { batch: _batch, ...noBatch } = validBatch as any;
        expect(validate(noBatch)).toBe(false);
    });

    it('does not require exports in batch mode', () => {
        const validate = compile();
        // validBatch has no `exports` key — still valid.
        expect(validBatch).not.toHaveProperty('exports');
        expect(validate(validBatch)).toBe(true);
    });

    it('still requires exports in lambda (default) mode', () => {
        const validate = compile();
        const lambdaNoExports = { app: 'x', stages: [{ stage: 'dev', mapping: { domain: 'd', path: '' } }] };
        expect(validate(lambdaNoExports)).toBe(false);
    });

    it('rejects a batch job without a name', () => {
        const validate = compile();
        const bad = JSON.parse(JSON.stringify(validBatch));
        delete bad.batch.jobs[0].name;
        expect(validate(bad)).toBe(false);
    });
});
