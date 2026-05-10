import { getOptions, stripOptions } from '../src/shared/options';

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
