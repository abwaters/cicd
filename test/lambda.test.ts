const mockSend = jest.fn();

jest.mock('../src/shared/aws-context', () => ({
    getRegion: jest.fn(async () => 'us-east-1'),
}));

jest.mock('@aws-sdk/client-lambda', () => {
    const makeCmd = (cmdType: string) => class {
        input: any;
        type: string;
        constructor(input: any) { this.input = input; this.type = cmdType; }
    };
    return {
        LambdaClient: jest.fn(() => ({ send: mockSend })),
        PublishVersionCommand: makeCmd('publishVersion'),
        ListVersionsByFunctionCommand: makeCmd('listVersions'),
        ListAliasesCommand: makeCmd('listAliases'),
        DeleteAliasCommand: makeCmd('deleteAlias'),
        CreateAliasCommand: makeCmd('createAlias'),
        UpdateAliasCommand: makeCmd('updateAlias'),
        GetFunctionCommand: makeCmd('getFunction'),
        DeleteFunctionCommand: makeCmd('deleteFunction'),
        ListTagsCommand: makeCmd('listTags'),
        UpdateFunctionConfigurationCommand: makeCmd('updateFunctionConfiguration'),
        PutProvisionedConcurrencyConfigCommand: makeCmd('putProvisionedConcurrency'),
        DeleteProvisionedConcurrencyConfigCommand: makeCmd('deleteProvisionedConcurrency'),
        AddPermissionCommand: makeCmd('addPermission'),
        ListEventSourceMappingsCommand: makeCmd('listEventSourceMappings'),
        CreateEventSourceMappingCommand: makeCmd('createEventSourceMapping'),
        UpdateEventSourceMappingCommand: makeCmd('updateEventSourceMapping'),
        DeleteEventSourceMappingCommand: makeCmd('deleteEventSourceMapping'),
    };
});

import * as lambda from '../src/shared/lambda';

beforeEach(() => {
    mockSend.mockReset();
});

describe('listVersions', () => {
    it('returns all versions across multiple pages', async () => {
        mockSend
            .mockResolvedValueOnce({
                Versions: [
                    { Version: '1', Description: 'myapp-aaa' },
                    { Version: '2', Description: 'myapp-bbb' },
                ],
                NextMarker: 'm2',
            })
            .mockResolvedValueOnce({
                Versions: [{ Version: '3', Description: 'myapp-ccc' }],
            });

        const versions = await lambda.listVersions('fn');

        expect(versions.map(v => v.version)).toEqual(['1', '2', '3']);
        expect(mockSend).toHaveBeenCalledTimes(2);
        expect(mockSend.mock.calls[0][0].input.Marker).toBeUndefined();
        expect(mockSend.mock.calls[1][0].input.Marker).toBe('m2');
    });

    it('returns empty array when there are no versions', async () => {
        mockSend.mockResolvedValueOnce({});
        await expect(lambda.listVersions('fn')).resolves.toEqual([]);
    });

    it('propagates AWS errors instead of returning an empty list', async () => {
        mockSend.mockRejectedValueOnce(Object.assign(new Error('not found'), { name: 'ResourceNotFoundException' }));
        await expect(lambda.listVersions('fn')).rejects.toThrow('not found');
    });
});

describe('listAliases', () => {
    it('returns all aliases across multiple pages', async () => {
        mockSend
            .mockResolvedValueOnce({
                Aliases: [{ Name: 'myapp-aaa', FunctionVersion: '1' }],
                NextMarker: 'm2',
            })
            .mockResolvedValueOnce({
                Aliases: [{ Name: 'myapp-bbb', FunctionVersion: '2', Description: 'desc' }],
            });

        const aliases = await lambda.listAliases('fn');

        expect(aliases).toEqual([
            { alias: 'myapp-aaa', version: '1', description: undefined },
            { alias: 'myapp-bbb', version: '2', description: 'desc' },
        ]);
        expect(mockSend).toHaveBeenCalledTimes(2);
        expect(mockSend.mock.calls[1][0].input.Marker).toBe('m2');
    });

    it('propagates AWS errors instead of returning an empty list', async () => {
        mockSend.mockRejectedValueOnce(new Error('boom'));
        await expect(lambda.listAliases('fn')).rejects.toThrow('boom');
    });
});
