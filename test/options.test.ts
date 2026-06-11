import { getOptions, stripOptions, unknownOptions, enforceKnownOptions } from '../src/shared/options';

// Silence the dryRun banner so test output stays clean.
const origLog = console.log;
beforeAll(() => { console.log = jest.fn(); });
afterAll(() => { console.log = origLog; });

describe('getOptions', () => {
    it('parses boolean long flags', () => {
        expect(getOptions(['--verbose', '--no-header'])).toEqual({
            verbose: true,
            noHeader: true,
        });
    });

    it('parses --key=value long flags', () => {
        expect(getOptions(['--keep=5', '--api-filter=foo'])).toEqual({
            keep: '5',
            apiFilter: 'foo',
        });
    });

    it('camelCases multi-segment kebab keys', () => {
        expect(getOptions(['--api-filter=x', '--web-filter=y', '--no-twilio'])).toEqual({
            apiFilter: 'x',
            webFilter: 'y',
            noTwilio: true,
        });
    });

    it('handles short flag -nh as noHeader', () => {
        expect(getOptions(['-nh'])).toEqual({ noHeader: true });
    });

    it('ignores positional args', () => {
        expect(getOptions(['stage', 'commit', '--verbose'])).toEqual({ verbose: true });
    });

    it('returns empty object when no options', () => {
        expect(getOptions([])).toEqual({});
        expect(getOptions(['stage', 'commit'])).toEqual({});
    });

    it('preserves empty string values', () => {
        expect(getOptions(['--api-filter='])).toEqual({ apiFilter: '' });
    });
});

describe('stripOptions', () => {
    it('removes --flags and short flags', () => {
        expect(stripOptions(['stage', '--verbose', 'commit', '-nh', '--keep=5'])).toEqual([
            'stage', 'commit',
        ]);
    });

    it('returns positional args unchanged', () => {
        expect(stripOptions(['deploy', 'prod', 'abc123'])).toEqual(['deploy', 'prod', 'abc123']);
    });

    it('returns empty for all-flags input', () => {
        expect(stripOptions(['--verbose', '--api', '-nh'])).toEqual([]);
    });
});

describe('unknownOptions', () => {
    it('accepts global options for every command', () => {
        expect(unknownOptions({ verbose: true, noHeader: true }, [])).toEqual([]);
    });

    it('accepts command-specific options', () => {
        expect(unknownOptions({ keep: '5', dryRun: true }, ['keep', 'dryRun'])).toEqual([]);
    });

    it('reports unrecognized options', () => {
        expect(unknownOptions({ apiFiler: 'x', verbose: true }, ['apiFilter'])).toEqual(['apiFiler']);
    });

    it('reports multiple unknown options', () => {
        expect(unknownOptions({ foo: true, bar: '1' }, [])).toEqual(['foo', 'bar']);
    });
});

describe('enforceKnownOptions', () => {
    let exitSpy: jest.SpyInstance;
    let errorSpy: jest.SpyInstance;

    beforeEach(() => {
        exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {
            throw new Error('process.exit called');
        }) as never);
        errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        exitSpy.mockRestore();
        errorSpy.mockRestore();
    });

    it('passes through when all options are known', () => {
        expect(() => enforceKnownOptions({ verbose: true, keep: '5' }, 'clean', ['keep', 'dryRun'])).not.toThrow();
        expect(exitSpy).not.toHaveBeenCalled();
    });

    it('exits with an error naming the mistyped flag in kebab-case', () => {
        expect(() => enforceKnownOptions({ apiFiler: 'x' }, 'deploy', ['apiFilter'])).toThrow('process.exit called');
        expect(exitSpy).toHaveBeenCalledWith(1);
        expect(errorSpy.mock.calls[0][0]).toContain("--api-filer");
        expect(errorSpy.mock.calls[0][0]).toContain("'deploy'");
    });

    it('lists every unknown flag', () => {
        expect(() => enforceKnownOptions({ foo: true, someBar: '1' }, 'info', [])).toThrow('process.exit called');
        expect(errorSpy.mock.calls[0][0]).toContain('--foo');
        expect(errorSpy.mock.calls[0][0]).toContain('--some-bar');
    });
});
