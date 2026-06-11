import { resolveScope, scopeLabel, deployTargetLabel, scopeOptionNames } from '../src/shared/scope';
import { CICDPlugin } from '../src/shared/plugin';

const twilioPlugin: CICDPlugin = { name: 'twilio', scopeFlag: 'noTwilio' };
const slackPlugin: CICDPlugin = { name: 'slack' };

describe('resolveScope (no plugins)', () => {
    it('default scope: everything except env-only', () => {
        const s = resolveScope({});
        expect(s.processEnv).toBe(true); // any process flag forces env on
        expect(s.processApi).toBe(true);
        expect(s.processSns).toBe(true);
        expect(s.processSqs).toBe(true);
        expect(s.processWorkers).toBe(true);
        expect(s.processWeb).toBe(true);
        expect(s.apiFilter).toBe('');
        expect(s.webFilter).toBe('');
        expect(s.enabledPluginNames).toEqual([]);
        expect(s.disabledPlugins.size).toBe(0);
    });

    it('--env limits scope to environment vars only', () => {
        const s = resolveScope({ env: true });
        expect(s.processEnv).toBe(true);
        expect(s.processApi).toBe(false);
        expect(s.processSns).toBe(false);
        expect(s.processSqs).toBe(false);
        expect(s.processWorkers).toBe(false);
        expect(s.processWeb).toBe(false);
    });

    it('--api narrows to api+env', () => {
        const s = resolveScope({ api: true });
        expect(s.processApi).toBe(true);
        expect(s.processSns).toBe(false);
        expect(s.processSqs).toBe(false);
        expect(s.processWorkers).toBe(false);
        expect(s.processWeb).toBe(false);
        expect(s.processEnv).toBe(true); // env auto-enabled when any compute flag is set
    });

    it('--web narrows to web only', () => {
        const s = resolveScope({ web: true });
        expect(s.processWeb).toBe(true);
        expect(s.processApi).toBe(false);
        expect(s.processSns).toBe(false);
        expect(s.processSqs).toBe(false);
        expect(s.processWorkers).toBe(false);
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

    it('passes through apiFilter and webFilter', () => {
        const s = resolveScope({ api: true, apiFilter: 'my-api', webFilter: 'site' });
        expect(s.apiFilter).toBe('my-api');
        expect(s.webFilter).toBe('site');
    });
});

describe('resolveScope (with plugins)', () => {
    it('plugins are enabled by default', () => {
        const s = resolveScope({}, [twilioPlugin, slackPlugin]);
        expect(s.enabledPluginNames).toEqual(['twilio', 'slack']);
        expect(s.disabledPlugins.size).toBe(0);
    });

    it('--env disables all plugins', () => {
        const s = resolveScope({ env: true }, [twilioPlugin, slackPlugin]);
        expect(s.enabledPluginNames).toEqual([]);
        expect(s.disabledPlugins.has('twilio')).toBe(true);
        expect(s.disabledPlugins.has('slack')).toBe(true);
    });

    it('specific-service flag disables all plugins', () => {
        const s = resolveScope({ api: true }, [twilioPlugin, slackPlugin]);
        expect(s.enabledPluginNames).toEqual([]);
        expect(s.disabledPlugins.has('twilio')).toBe(true);
    });

    it('explicit scopeFlag disables just that plugin', () => {
        const s = resolveScope({ noTwilio: true }, [twilioPlugin, slackPlugin]);
        expect(s.disabledPlugins.has('twilio')).toBe(true);
        expect(s.disabledPlugins.has('slack')).toBe(false);
        expect(s.enabledPluginNames).toEqual(['slack']);
    });

    it('default scopeFlag is derived from plugin name (no<Capitalized>)', () => {
        const s = resolveScope({ noSlack: true }, [twilioPlugin, slackPlugin]);
        expect(s.disabledPlugins.has('slack')).toBe(true);
        expect(s.disabledPlugins.has('twilio')).toBe(false);
    });
});

describe('scopeLabel', () => {
    it('renders Environment only when env-only', () => {
        const label = scopeLabel(resolveScope({ env: true }));
        expect(label).toBe('Environment only');
    });

    it('renders combined parts in order (no plugins)', () => {
        const label = scopeLabel(resolveScope({}));
        expect(label).toBe('Environment + API + SNS + SQS + Workers + Web');
    });

    it('appends enabled plugin names with capitalization', () => {
        const label = scopeLabel(resolveScope({}, [twilioPlugin]));
        expect(label).toBe('Environment + API + SNS + SQS + Workers + Web + Twilio');
    });

    it('omits disabled plugin from label', () => {
        const label = scopeLabel(resolveScope({ noTwilio: true }, [twilioPlugin]));
        expect(label).toBe('Environment + API + SNS + SQS + Workers + Web');
    });

    it('renders API filter in label when set', () => {
        const label = scopeLabel(resolveScope({ api: true, apiFilter: 'foo' }));
        expect(label).toBe('Environment + API (foo)');
    });

    it('renders Web filter in label when set (with Environment prefix)', () => {
        const label = scopeLabel(resolveScope({ web: true, webFilter: 'site' }));
        expect(label).toBe('Environment + Web (site)');
    });
});

describe('deployTargetLabel', () => {
    it('returns fargate regardless of scope/exports', () => {
        const label = deployTargetLabel(resolveScope({}), { computeMode: 'fargate', exportTypes: ['api'], hasWorkers: true });
        expect(label).toBe('fargate');
    });

    it('web-only project full deploy reports [web], not [lambda]', () => {
        const label = deployTargetLabel(resolveScope({}), { computeMode: 'lambda', exportTypes: ['web'], hasWorkers: false });
        expect(label).toBe('web');
    });

    it('mixed api+web project reports api+web', () => {
        const label = deployTargetLabel(resolveScope({}), { computeMode: 'lambda', exportTypes: ['api', 'web'], hasWorkers: false });
        expect(label).toBe('api+web');
    });

    it('only reports kinds that are in scope', () => {
        const label = deployTargetLabel(resolveScope({ web: true }), { computeMode: 'lambda', exportTypes: ['api', 'web'], hasWorkers: false });
        expect(label).toBe('web');
    });

    it('includes workers when configured and in scope', () => {
        const label = deployTargetLabel(resolveScope({}), { computeMode: 'lambda', exportTypes: ['api'], hasWorkers: true });
        expect(label).toBe('api+workers');
    });

    it('env-only deploy reports env', () => {
        const label = deployTargetLabel(resolveScope({ env: true }), { computeMode: 'lambda', exportTypes: ['api'], hasWorkers: false });
        expect(label).toBe('env');
    });

    it('reports env when nothing configured matches but env is on', () => {
        const label = deployTargetLabel(resolveScope({}), { computeMode: 'lambda', exportTypes: [], hasWorkers: false });
        expect(label).toBe('env');
    });

    it('falls back to lambda when neither resources nor env are in scope', () => {
        const emptyScope = { ...resolveScope({ env: true }), processEnv: false };
        const label = deployTargetLabel(emptyScope, { computeMode: 'lambda', exportTypes: [], hasWorkers: false });
        expect(label).toBe('lambda');
    });

    it('preserves canonical order api+sns+sqs+workers+web', () => {
        const label = deployTargetLabel(resolveScope({}), { computeMode: 'lambda', exportTypes: ['web', 'sqs', 'sns', 'api'], hasWorkers: true });
        expect(label).toBe('api+sns+sqs+workers+web');
    });
});

describe('scopeOptionNames', () => {
    it('returns the static scope flags with no plugins', () => {
        expect(scopeOptionNames()).toEqual([
            'env', 'api', 'sns', 'sqs', 'workers', 'web', 'apiFilter', 'webFilter',
        ]);
    });

    it('includes each plugin scope flag', () => {
        const names = scopeOptionNames([twilioPlugin, slackPlugin]);
        expect(names).toContain('noTwilio');
        expect(names).toContain('noSlack');
    });
});
