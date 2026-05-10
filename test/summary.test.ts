import { printDeploymentSummary } from '../src/shared/summary';

const origLog = console.log;
beforeAll(() => { console.log = jest.fn(); });
afterAll(() => { console.log = origLog; });

describe('printDeploymentSummary', () => {
    it('returns empty parts for fully empty results', () => {
        expect(printDeploymentSummary({})).toEqual([]);
    });

    it('summarizes env results', () => {
        const parts = printDeploymentSummary({
            env: [
                { name: 'fn-a', updated: true, varCount: 5 },
                { name: 'fn-b', updated: false, varCount: 0 },
                { name: 'fn-c', updated: true, varCount: 3 },
            ],
        });
        expect(parts).toEqual(['2 functions configured']);
    });

    it('summarizes api results with new+existing counts', () => {
        const parts = printDeploymentSummary({
            api: {
                functions: [
                    { name: 'fn1', action: 'created', version: '5' },
                    { name: 'fn2', action: 'exists', version: '3' },
                    { name: 'fn3', action: 'created', version: '6' },
                ],
                apis: [
                    { name: 'api1', deployment: 'created', stage: 'updated', mapping: 'existing', throttle: '100/200', functions: 2 },
                ],
            },
        });
        expect(parts).toEqual(['1 APIs deployed (2 new, 1 existing)']);
    });

    it('summarizes sns subscribed/skipped counts', () => {
        const parts = printDeploymentSummary({
            sns: {
                functions: [],
                subscriptions: [
                    { name: 't1', action: 'subscribed' },
                    { name: 't2', action: 'subscribed' },
                    { name: 't3', action: 'skipped' },
                ],
            },
        });
        expect(parts).toEqual(['2 topics subscribed, 1 skipped']);
    });

    it('omits sns part when no subscriptions changed', () => {
        const parts = printDeploymentSummary({
            sns: { functions: [], subscriptions: [] },
        });
        expect(parts).toEqual([]);
    });

    it('summarizes sqs events with all 4 action segments', () => {
        const parts = printDeploymentSummary({
            sqs: {
                functions: [],
                eventSources: [
                    { name: 'q1', action: 'created' },
                    { name: 'q2', action: 'updated' },
                    { name: 'q3', action: 'exists' },
                    { name: 'q4', action: 'skipped' },
                ],
            },
        });
        expect(parts).toEqual(['SQS: 1 created, 1 updated, 1 existing, 1 skipped']);
    });

    it('summarizes workers with mixed actions', () => {
        const parts = printDeploymentSummary({
            workers: {
                functions: [
                    { name: 'w1', action: 'created', version: '1' },
                    { name: 'w2', action: 'updated', version: '2' },
                    { name: 'w3', action: 'exists', version: '3' },
                ],
            },
        });
        expect(parts).toEqual(['Workers: 1 new, 1 updated, 1 existing']);
    });

    it('summarizes web export count and total files', () => {
        const parts = printDeploymentSummary({
            web: {
                exports: [
                    { name: 'site', bucket: 'b', distribution: 'd', originPath: '/dev/abc', fileCount: 12, totalBytes: 1234, noindexInjected: false },
                    { name: 'admin', bucket: 'b', distribution: 'd', originPath: '/dev/abc', fileCount: 3, totalBytes: 99, noindexInjected: true, invalidationId: 'I1' },
                ],
            },
        });
        expect(parts).toEqual(['2 web export(s) deployed (15 files)']);
    });

    it('summarizes twilio webhook update', () => {
        const parts = printDeploymentSummary({
            twilio: { messagingSid: 'MGabc', webhookUrl: 'https://x', action: 'updated' },
        });
        expect(parts).toEqual(['Twilio webhook updated']);
    });

    it('combines parts from multiple sections in order', () => {
        const parts = printDeploymentSummary({
            env: [{ name: 'fn', updated: true, varCount: 1 }],
            api: { functions: [], apis: [{ name: 'a', deployment: 'created', stage: 'updated', mapping: 'existing', throttle: '', functions: 0 }] },
            web: { exports: [{ name: 'site', bucket: 'b', distribution: 'd', originPath: '/x', fileCount: 1, totalBytes: 1, noindexInjected: false }] },
        });
        expect(parts).toEqual([
            '1 functions configured',
            '1 APIs deployed (0 new, 0 existing)',
            '1 web export(s) deployed (1 files)',
        ]);
    });
});
