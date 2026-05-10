import { commitFromAlias, unionKeep, composeMappingPath, decideMappingAction } from '../src/shared/cicd';
import { StageConfig, ExportConfig } from '../src/types';

describe('commitFromAlias', () => {
    it('extracts commit from {app}-{commit}', () => {
        expect(commitFromAlias('myapp-abc1234')).toBe('abc1234');
    });

    it('keeps everything after the FIRST hyphen when app name has hyphens', () => {
        expect(commitFromAlias('my-app-abc1234')).toBe('app-abc1234');
    });

    it('returns the input unchanged when there is no hyphen', () => {
        expect(commitFromAlias('noHyphen')).toBe('noHyphen');
    });

    it('handles trailing hyphen as empty commit', () => {
        expect(commitFromAlias('app-')).toBe('');
    });

    it('handles leading hyphen by treating empty app prefix', () => {
        expect(commitFromAlias('-abc1234')).toBe('abc1234');
    });
});

describe('unionKeep', () => {
    it('returns empty when input map is empty', () => {
        expect(unionKeep(new Map(), ['dev', 'prod'])).toEqual(new Set());
    });

    it('returns empty when stage names not in map', () => {
        const m = new Map([['dev', new Set(['a'])]]);
        expect(unionKeep(m, ['prod'])).toEqual(new Set());
    });

    it('unions commits across requested stages', () => {
        const m = new Map([
            ['dev', new Set(['a', 'b'])],
            ['stage', new Set(['c'])],
            ['prod', new Set(['b', 'd'])],
        ]);
        expect(unionKeep(m, ['dev', 'prod'])).toEqual(new Set(['a', 'b', 'd']));
    });

    it('returns full union when every stage is requested', () => {
        const m = new Map([
            ['dev', new Set(['a'])],
            ['prod', new Set(['b'])],
        ]);
        expect(unionKeep(m, m.keys())).toEqual(new Set(['a', 'b']));
    });

    it('skips stages absent from the map', () => {
        const m = new Map([['dev', new Set(['a'])]]);
        expect(unionKeep(m, ['dev', 'missing'])).toEqual(new Set(['a']));
    });
});

describe('composeMappingPath', () => {
    function stage(mapping: Partial<StageConfig['mapping']>): StageConfig {
        return { stage: 'dev', mapping: { domain: 'd', ...mapping } } as StageConfig;
    }
    function api(parts: { prefix?: string; path?: string }): ExportConfig {
        return { type: 'api', name: 'a', ...parts };
    }

    it('joins stage path + api prefix + api path', () => {
        expect(composeMappingPath(stage({ path: 'v1' }), api({ prefix: 'auth', path: 'login' })))
            .toBe('v1/auth/login');
    });

    it('omits empty segments', () => {
        expect(composeMappingPath(stage({}), api({ prefix: 'auth' }))).toBe('auth');
        expect(composeMappingPath(stage({ path: 'v1' }), api({}))).toBe('v1');
        expect(composeMappingPath(stage({}), api({}))).toBe('');
    });

    it('preserves order: stage → api.prefix → api.path', () => {
        expect(composeMappingPath(stage({ path: 'A' }), api({ prefix: 'B', path: 'C' })))
            .toBe('A/B/C');
    });

    it('skips api.prefix while keeping api.path', () => {
        expect(composeMappingPath(stage({ path: 'v1' }), api({ path: 'login' })))
            .toBe('v1/login');
    });
});

describe('decideMappingAction', () => {
    it('returns create when no mapping exists for this api+stage', () => {
        const mappings = [{ basePath: 'other/path', restApiId: 'other-api', stage: 'tools' }];
        expect(decideMappingAction(mappings, 'my-api', 'tools', 'tools/hours'))
            .toEqual({ action: 'create' });
    });

    it('returns existing when mapping is already at the desired path', () => {
        const mappings = [{ basePath: 'tools/hours', restApiId: 'my-api', stage: 'tools' }];
        expect(decideMappingAction(mappings, 'my-api', 'tools', 'tools/hours'))
            .toEqual({ action: 'existing' });
    });

    it('returns move when api+stage mapping exists but at a different path', () => {
        const mappings = [{ basePath: 'tools/hours', restApiId: 'my-api', stage: 'tools' }];
        expect(decideMappingAction(mappings, 'my-api', 'tools', 'tools/admin/hours'))
            .toEqual({ action: 'move', from: 'tools/hours' });
    });

    it('returns move with empty from when current basePath is "(none)"', () => {
        const mappings = [{ basePath: '(none)', restApiId: 'my-api', stage: 'tools' }];
        expect(decideMappingAction(mappings, 'my-api', 'tools', 'admin'))
            .toEqual({ action: 'move', from: '' });
    });

    it('returns move with empty from when current basePath is undefined', () => {
        const mappings = [{ basePath: undefined, restApiId: 'my-api', stage: 'tools' }];
        expect(decideMappingAction(mappings, 'my-api', 'tools', 'admin'))
            .toEqual({ action: 'move', from: '' });
    });

    it('treats desired path matching "(none)" mapping as existing', () => {
        const mappings = [{ basePath: '(none)', restApiId: 'my-api', stage: 'tools' }];
        expect(decideMappingAction(mappings, 'my-api', 'tools', ''))
            .toEqual({ action: 'existing' });
    });

    it('returns conflict when desired path is owned by a different api', () => {
        const mappings = [
            { basePath: 'tools/hours', restApiId: 'my-api', stage: 'tools' },
            { basePath: 'tools/admin/hours', restApiId: 'other-api', stage: 'tools' }
        ];
        const result = decideMappingAction(mappings, 'my-api', 'tools', 'tools/admin/hours');
        expect(result).toEqual({
            action: 'conflict',
            conflictApiId: 'other-api',
            conflictStage: 'tools'
        });
    });

    it('returns conflict when no own mapping exists but desired path is taken', () => {
        const mappings = [{ basePath: 'tools/hours', restApiId: 'other-api', stage: 'tools' }];
        const result = decideMappingAction(mappings, 'my-api', 'tools', 'tools/hours');
        expect(result).toEqual({
            action: 'conflict',
            conflictApiId: 'other-api',
            conflictStage: 'tools'
        });
    });

    it('returns conflict when desired path is owned by same api in a different stage', () => {
        const mappings = [{ basePath: 'tools/hours', restApiId: 'my-api', stage: 'prod' }];
        const result = decideMappingAction(mappings, 'my-api', 'tools', 'tools/hours');
        expect(result).toEqual({
            action: 'conflict',
            conflictApiId: 'my-api',
            conflictStage: 'prod'
        });
    });

    it('handles reverse migration: removing prefix moves mapping back to unprefixed path', () => {
        const mappings = [{ basePath: 'tools/admin/hours', restApiId: 'my-api', stage: 'tools' }];
        expect(decideMappingAction(mappings, 'my-api', 'tools', 'tools/hours'))
            .toEqual({ action: 'move', from: 'tools/admin/hours' });
    });

    it('returns create when mapping list is empty', () => {
        expect(decideMappingAction([], 'my-api', 'tools', 'tools/hours'))
            .toEqual({ action: 'create' });
    });
});
