import { selectRecentTags, parseRepositoryName, ImageDetail } from '../src/shared/ecr';

describe('ecr.parseRepositoryName', () => {
    it('strips the registry host from a full repo URI', () => {
        expect(parseRepositoryName('907688428238.dkr.ecr.us-east-1.amazonaws.com/ccfw-reminders'))
            .toBe('ccfw-reminders');
    });
    it('returns the input unchanged when there is no host', () => {
        expect(parseRepositoryName('ccfw-reminders')).toBe('ccfw-reminders');
    });
});

describe('ecr.selectRecentTags', () => {
    const details: ImageDetail[] = [
        { tags: ['old1'], pushedAt: new Date('2026-01-01T00:00:00Z') },
        { tags: ['newest'], pushedAt: new Date('2026-06-01T00:00:00Z') },
        { tags: ['mid', 'latest'], pushedAt: new Date('2026-03-01T00:00:00Z') },
        { tags: [], pushedAt: new Date('2026-07-01T00:00:00Z') }, // untagged — ignored
    ];

    it('orders tags newest-first and skips untagged images', () => {
        expect(selectRecentTags(details)).toEqual(['newest', 'mid', 'latest', 'old1']);
    });

    it('honors the limit', () => {
        expect(selectRecentTags(details, 2)).toEqual(['newest', 'mid']);
    });

    it('returns [] for an empty repository', () => {
        expect(selectRecentTags([])).toEqual([]);
    });
});
