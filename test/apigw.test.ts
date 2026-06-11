const mockSend = jest.fn();

jest.mock('../src/shared/aws-context', () => ({
    getRegion: jest.fn(async () => 'us-east-1'),
}));

jest.mock('../src/shared/config', () => ({
    getConfig: jest.fn(async (key: string) => (key === 'app' ? 'myapp' : undefined)),
}));

jest.mock('@aws-sdk/client-api-gateway', () => {
    const makeCmd = (cmdType: string) => class {
        input: any;
        type: string;
        constructor(input: any) { this.input = input; this.type = cmdType; }
    };
    return {
        APIGatewayClient: jest.fn(() => ({ send: mockSend })),
        CreateDeploymentCommand: makeCmd('createDeployment'),
        DeleteDeploymentCommand: makeCmd('deleteDeployment'),
        GetDeploymentsCommand: makeCmd('getDeployments'),
        UpdateStageCommand: makeCmd('updateStage'),
        GetStagesCommand: makeCmd('getStages'),
        CreateStageCommand: makeCmd('createStage'),
        CreateBasePathMappingCommand: makeCmd('createBasePathMapping'),
        DeleteBasePathMappingCommand: makeCmd('deleteBasePathMapping'),
        GetBasePathMappingsCommand: makeCmd('getBasePathMappings'),
        TagResourceCommand: makeCmd('tagResource'),
    };
});

jest.mock('@aws-sdk/client-apigatewayv2', () => {
    const makeCmd = (cmdType: string) => class {
        input: any;
        type: string;
        constructor(input: any) { this.input = input; this.type = cmdType; }
    };
    return {
        ApiGatewayV2Client: jest.fn(() => ({ send: mockSend })),
        CreateApiMappingCommand: makeCmd('createApiMapping'),
        GetApiMappingsCommand: makeCmd('getApiMappings'),
    };
});

import * as apigw from '../src/shared/apigw';

beforeEach(() => {
    mockSend.mockReset();
});

describe('listDeployments', () => {
    it('returns all deployments across multiple pages', async () => {
        mockSend
            .mockResolvedValueOnce({ items: [{ id: 'd1' }, { id: 'd2' }], position: 'page2' })
            .mockResolvedValueOnce({ items: [{ id: 'd3' }], position: 'page3' })
            .mockResolvedValueOnce({ items: [{ id: 'd4' }] });

        const deployments = await apigw.listDeployments('api123');

        expect(deployments.map(d => d.id)).toEqual(['d1', 'd2', 'd3', 'd4']);
        expect(mockSend).toHaveBeenCalledTimes(3);
        expect(mockSend.mock.calls[0][0].input.position).toBeUndefined();
        expect(mockSend.mock.calls[1][0].input.position).toBe('page2');
        expect(mockSend.mock.calls[2][0].input.position).toBe('page3');
    });

    it('returns a single page when there is no position token', async () => {
        mockSend.mockResolvedValueOnce({ items: [{ id: 'd1' }] });
        const deployments = await apigw.listDeployments('api123');
        expect(deployments).toHaveLength(1);
        expect(mockSend).toHaveBeenCalledTimes(1);
    });

    it('returns empty array when there are no deployments', async () => {
        mockSend.mockResolvedValueOnce({});
        await expect(apigw.listDeployments('api123')).resolves.toEqual([]);
    });

    it('propagates AWS errors instead of returning an empty list', async () => {
        mockSend.mockRejectedValueOnce(Object.assign(new Error('denied'), { name: 'AccessDeniedException' }));
        await expect(apigw.listDeployments('api123')).rejects.toThrow('denied');
    });
});

describe('listStages', () => {
    it('returns stages', async () => {
        mockSend.mockResolvedValueOnce({ item: [{ stageName: 'dev' }, { stageName: 'prod' }] });
        const stages = await apigw.listStages('api123');
        expect(stages.map(s => s.stageName)).toEqual(['dev', 'prod']);
    });

    it('propagates AWS errors', async () => {
        mockSend.mockRejectedValueOnce(new Error('boom'));
        await expect(apigw.listStages('api123')).rejects.toThrow('boom');
    });
});

describe('listBasePathMappings', () => {
    it('returns all mappings across multiple pages', async () => {
        mockSend
            .mockResolvedValueOnce({ items: [{ basePath: 'a' }], position: 'next' })
            .mockResolvedValueOnce({ items: [{ basePath: 'b' }] });

        const mappings = await apigw.listBasePathMappings('example.com');

        expect(mappings.map(m => m.basePath)).toEqual(['a', 'b']);
        expect(mockSend).toHaveBeenCalledTimes(2);
        expect(mockSend.mock.calls[1][0].input.position).toBe('next');
    });

    it('propagates AWS errors', async () => {
        mockSend.mockRejectedValueOnce(new Error('boom'));
        await expect(apigw.listBasePathMappings('example.com')).rejects.toThrow('boom');
    });
});

describe('listApiMappingsV2', () => {
    it('returns all mappings across multiple pages', async () => {
        mockSend
            .mockResolvedValueOnce({ Items: [{ ApiMappingKey: 'a' }], NextToken: 't2' })
            .mockResolvedValueOnce({ Items: [{ ApiMappingKey: 'b' }] });

        const mappings = await apigw.listApiMappingsV2('example.com');

        expect(mappings.map(m => m.ApiMappingKey)).toEqual(['a', 'b']);
        expect(mockSend).toHaveBeenCalledTimes(2);
        expect(mockSend.mock.calls[1][0].input.NextToken).toBe('t2');
    });

    it('propagates AWS errors', async () => {
        mockSend.mockRejectedValueOnce(new Error('boom'));
        await expect(apigw.listApiMappingsV2('example.com')).rejects.toThrow('boom');
    });
});

describe('createDeployment', () => {
    it('returns the created deployment', async () => {
        mockSend.mockResolvedValueOnce({ id: 'dep1', description: 'abc123' });
        const deployment = await apigw.createDeployment('api123', 'abc123');
        expect(deployment).toEqual({ id: 'dep1', description: 'abc123' });
    });

    it('propagates AWS errors instead of returning null', async () => {
        mockSend.mockRejectedValueOnce(new Error('limit exceeded'));
        await expect(apigw.createDeployment('api123', 'abc123')).rejects.toThrow('limit exceeded');
    });
});

describe('createCustomDomainMappingV2', () => {
    it('propagates conflict errors to the caller', async () => {
        mockSend.mockRejectedValueOnce(Object.assign(new Error('exists'), { name: 'ConflictException' }));
        await expect(apigw.createCustomDomainMappingV2('example.com', 'api123', 'dev', 'path'))
            .rejects.toMatchObject({ name: 'ConflictException' });
    });
});

describe('createStage', () => {
    it('propagates AWS errors', async () => {
        mockSend.mockRejectedValueOnce(new Error('boom'));
        await expect(apigw.createStage('api123', 'dev', 'dep1', 'myapp-abc', null)).rejects.toThrow('boom');
    });
});

describe('updateStage', () => {
    it('propagates stage update errors', async () => {
        mockSend.mockRejectedValueOnce(new Error('boom'));
        await expect(apigw.updateStage('api123', 'dev', 'dep1', 'myapp-abc', null)).rejects.toThrow('boom');
    });

    it('does not fail the deploy when only tagging fails', async () => {
        mockSend
            .mockResolvedValueOnce({})                       // UpdateStageCommand
            .mockRejectedValueOnce(new Error('tag failed')); // TagResourceCommand
        await expect(apigw.updateStage('api123', 'dev', 'dep1', 'myapp-abc', null)).resolves.toBeUndefined();
        expect(mockSend).toHaveBeenCalledTimes(2);
    });
});
