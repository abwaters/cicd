import { GitHubDeployment } from '../src/types';

jest.mock('../src/shared/config', () => ({
    getConfig: jest.fn(),
    initConfig: jest.fn(),
}));
jest.mock('../src/shared/github', () => ({
    listDeployments: jest.fn(),
    isGhAvailable: jest.fn(() => true),
    createDeployment: jest.fn(),
    updateDeploymentStatus: jest.fn(),
}));

import { buildKeepSet } from '../src/shared/cicd';
import * as config from '../src/shared/config';
import * as github from '../src/shared/github';

const mockGetConfig = config.getConfig as unknown as jest.Mock;
const mockListDeployments = github.listDeployments as jest.Mock;

function dep(ref: string, status: string, createdAt = '2026-01-01T00:00:00Z'): GitHubDeployment {
    return {
        id: Math.floor(Math.random() * 1e6),
        ref,
        environment: 'dev',
        description: '',
        status,
        statusDescription: '',
        createdAt,
    };
}

describe('buildKeepSet', () => {
    beforeEach(() => {
        mockGetConfig.mockReset();
        mockListDeployments.mockReset();
    });

    function setupConfig(repo: string | undefined, stages: string[]) {
        mockGetConfig.mockImplementation(async (key: string) => {
            if (key === 'repo') return repo;
            if (key === 'stages') return stages.map(s => ({ stage: s }));
            return undefined;
        });
    }

    it('returns empty sets for every stage when repo is not configured', async () => {
        setupConfig(undefined, ['dev', 'prod']);
        const keep = await buildKeepSet(5);
        expect(keep.size).toBe(2);
        expect(keep.get('dev')).toEqual(new Set());
        expect(keep.get('prod')).toEqual(new Set());
        expect(mockListDeployments).not.toHaveBeenCalled();
    });

    it('keeps the most recent N successful refs per stage', async () => {
        setupConfig('owner/repo', ['dev']);
        mockListDeployments.mockReturnValueOnce([
            dep('aaa', 'success'),
            dep('bbb', 'success'),
            dep('ccc', 'success'),
            dep('ddd', 'success'),
        ]);
        const keep = await buildKeepSet(2);
        expect(keep.get('dev')).toEqual(new Set(['aaa', 'bbb']));
    });

    it('treats both success and inactive as recoverable, skips other states', async () => {
        setupConfig('owner/repo', ['dev']);
        mockListDeployments.mockReturnValueOnce([
            dep('aaa', 'failure'),
            dep('bbb', 'success'),
            dep('ccc', 'pending'),
            dep('ddd', 'inactive'),
            dep('eee', 'error'),
            dep('fff', 'success'),
        ]);
        const keep = await buildKeepSet(5);
        expect(keep.get('dev')).toEqual(new Set(['bbb', 'ddd', 'fff']));
    });

    it('caps each stage to N even with more successful results', async () => {
        setupConfig('owner/repo', ['dev']);
        const refs = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
        mockListDeployments.mockReturnValueOnce(refs.map(r => dep(r, 'success')));
        const keep = await buildKeepSet(3);
        expect(keep.get('dev')).toEqual(new Set(['a', 'b', 'c']));
    });

    it('builds independent keep sets per stage', async () => {
        setupConfig('owner/repo', ['dev', 'prod']);
        mockListDeployments
            .mockReturnValueOnce([dep('dev1', 'success'), dep('dev2', 'success')])
            .mockReturnValueOnce([dep('prod1', 'success')]);
        const keep = await buildKeepSet(5);
        expect(keep.get('dev')).toEqual(new Set(['dev1', 'dev2']));
        expect(keep.get('prod')).toEqual(new Set(['prod1']));
    });

    it('requests at least n*4 deployments to filter through failures', async () => {
        setupConfig('owner/repo', ['dev']);
        mockListDeployments.mockReturnValueOnce([]);
        await buildKeepSet(3);
        expect(mockListDeployments).toHaveBeenCalledWith('owner/repo', 'dev', 12);
    });

    it('returns empty set for a stage with no successful deployments', async () => {
        setupConfig('owner/repo', ['dev']);
        mockListDeployments.mockReturnValueOnce([
            dep('a', 'failure'),
            dep('b', 'pending'),
        ]);
        const keep = await buildKeepSet(5);
        expect(keep.get('dev')).toEqual(new Set());
    });
});
