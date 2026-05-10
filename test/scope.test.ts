import { resolveScope, scopeLabel } from '../src/shared/scope';

describe('resolveScope', () => {
    it('default scope: everything except env-only', () => {
        const s = resolveScope({});
        expect(s.processEnv).toBe(true); // any process flag forces env on
        expect(s.processApi).toBe(true);
        expect(s.processSns).toBe(true);
        expect(s.processSqs).toBe(true);
        expect(s.processWorkers).toBe(true);
        expect(s.processWeb).toBe(true);
        expect(s.processTwilio).toBe(true);
        expect(s.apiFilter).toBe('');
        expect(s.webFilter).toBe('');
    });

    it('--env limits scope to environment vars only and disables twilio', () => {
        const s = resolveScope({ env: true });
        expect(s.processEnv).toBe(true);
        expect(s.processApi).toBe(false);
        expect(s.processSns).toBe(false);
        expect(s.processSqs).toBe(false);
        expect(s.processWorkers).toBe(false);
        expect(s.processWeb).toBe(false);
        expect(s.processTwilio).toBe(false);
    });

    it('--api narrows to api+env, disables twilio', () => {
        const s = resolveScope({ api: true });
        expect(s.processApi).toBe(true);
        expect(s.processSns).toBe(false);
        expect(s.processSqs).toBe(false);
        expect(s.processWorkers).toBe(false);
        expect(s.processWeb).toBe(false);
        expect(s.processTwilio).toBe(false);
        expect(s.processEnv).toBe(true); // env auto-enabled when any compute flag is set
    });

    it('--web narrows to web only and disables twilio (web is non-compute)', () => {
        const s = resolveScope({ web: true });
        expect(s.processWeb).toBe(true);
        expect(s.processApi).toBe(false);
        expect(s.processSns).toBe(false);
        expect(s.processSqs).toBe(false);
        expect(s.processWorkers).toBe(false);
        expect(s.processTwilio).toBe(false);
        // env auto-on requires api/sns/sqs/workers — web alone leaves env off
        expect(s.processEnv).toBe(false);
    });

    it('combines --api and --sns', () => {
        const s = resolveScope({ api: true, sns: true });
        expect(s.processApi).toBe(true);
        expect(s.processSns).toBe(true);
        expect(s.processSqs).toBe(false);
        expect(s.processWorkers).toBe(false);
        expect(s.processWeb).toBe(false);
        expect(s.processEnv).toBe(true);
    });

    it('--no-twilio strips twilio from default scope', () => {
        const s = resolveScope({ noTwilio: true });
        expect(s.processTwilio).toBe(false);
        expect(s.processApi).toBe(true);
    });

    it('passes through apiFilter and webFilter', () => {
        const s = resolveScope({ api: true, apiFilter: 'my-api', webFilter: 'site' });
        expect(s.apiFilter).toBe('my-api');
        expect(s.webFilter).toBe('site');
    });
});

describe('scopeLabel', () => {
    it('renders Environment only when env-only', () => {
        const label = scopeLabel(resolveScope({ env: true }));
        expect(label).toBe('Environment only');
    });

    it('renders combined parts in order', () => {
        const label = scopeLabel(resolveScope({}));
        expect(label).toBe('Environment + API + SNS + SQS + Workers + Web + Twilio');
    });

    it('renders API filter in label when set', () => {
        const label = scopeLabel(resolveScope({ api: true, apiFilter: 'foo' }));
        expect(label).toBe('Environment + API (foo)');
    });

    it('renders Web filter in label when set (with Environment prefix)', () => {
        // scopeLabel always prefixes "Environment" when any non-env part exists,
        // even though processEnv may be false for --web alone. Test documents
        // current behavior.
        const label = scopeLabel(resolveScope({ web: true, webFilter: 'site' }));
        expect(label).toBe('Environment + Web (site)');
    });
});
