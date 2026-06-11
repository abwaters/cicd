// Orchestration tests for cicd.ts: exercise init/export resolution, environment
// variable resolution with stage overrides, and the API Gateway deploy flow
// against mocked AWS wrappers. Enabled by cicd.resetForTest(), which clears the
// module state between tests.

jest.mock('../src/shared/aws-context', () => ({
    getRegion: jest.fn(async () => 'us-east-1'),
    getAccount: jest.fn(async () => '123456789012'),
}));

const mockGetConfig = jest.fn();
jest.mock('../src/shared/config', () => ({
    getConfig: (key: string) => mockGetConfig(key),
}));

const mockListExports = jest.fn();
jest.mock('../src/shared/cloudformation', () => ({
    listExports: () => mockListExports(),
}));

jest.mock('../src/shared/ps', () => ({
    getParameterValue: jest.fn(async () => null),
}));

jest.mock('../src/shared/lambda', () => ({
    listVersions: jest.fn(async () => []),
    listAliases: jest.fn(async () => []),
    publishNewVersion: jest.fn(async () => ({
        version: '1',
        description: 'myapp-abc1234',
        arn: 'arn:aws:lambda:us-east-1:123456789012:function:my-func:1',
    })),
    listFunctionTags: jest.fn(async () => ({})),
    createAlias: jest.fn(async () => ({})),
    updateAlias: jest.fn(async () => ({})),
    updateProvisionedConcurrency: jest.fn(async () => {}),
    addFunctionPermission: jest.fn(async () => {}),
    updateEnvironmentVariables: jest.fn(async () => {}),
}));

jest.mock('../src/shared/apigw', () => ({
    listDeployments: jest.fn(async () => []),
    listStages: jest.fn(async () => []),
    listBasePathMappings: jest.fn(async () => []),
    createDeployment: jest.fn(async () => ({ id: 'dep1', description: 'abc1234' })),
    createStage: jest.fn(async () => {}),
    updateStage: jest.fn(async () => {}),
    createCustomDomainMappingV2: jest.fn(async () => {}),
    deleteBasePathMapping: jest.fn(async () => {}),
    listApiMappingsV2: jest.fn(async () => []),
}));

import * as cicd from '../src/shared/cicd';
import * as lambda from '../src/shared/lambda';
import * as apigw from '../src/shared/apigw';

const mockedLambda = lambda as jest.Mocked<typeof lambda>;
const mockedApigw = apigw as jest.Mocked<typeof apigw>;

// Rebuilt for every test so initExports' mutation of the config objects
// (resolving `value` onto them) never leaks across tests.
function freshFixture() {
    return {
        app: 'myapp',
        environment: {
            PLAIN: 'value1',
            FROM_EXPORT: '!ImportValue SharedExport',
        },
        exports: [
            {
                name: 'MyApi',
                type: 'api',
                functions: [
                    { name: 'MyFunc', method: 'ANY', env: ['PLAIN', 'FROM_EXPORT'] },
                ],
            },
        ],
        workers: [],
        stages: [
            {
                stage: 'dev',
                mapping: { domain: 'api.example.com', path: 'dev' },
                environment: { PLAIN: 'stage-override' },
            },
            { stage: 'prod', mapping: { domain: 'api.example.com', path: '' } },
        ],
    } as Record<string, any>;
}

let fixture: Record<string, any>;

beforeEach(() => {
    jest.clearAllMocks();
    cicd.resetForTest();
    fixture = freshFixture();
    mockGetConfig.mockImplementation(async (key: string) => fixture[key]);
    mockListExports.mockResolvedValue([
        { Name: 'MyApi', Value: 'api123' },
        { Name: 'MyFunc', Value: 'my-func' },
        { Name: 'SharedExport', Value: 'shared-value' },
    ]);

    // Re-apply defaults: clearAllMocks() does not undo a test's
    // mockResolvedValue overrides, so set them explicitly each time.
    mockedLambda.listVersions.mockResolvedValue([]);
    mockedLambda.listAliases.mockResolvedValue([]);
    mockedLambda.publishNewVersion.mockResolvedValue({
        version: '1',
        description: 'myapp-abc1234',
        arn: 'arn:aws:lambda:us-east-1:123456789012:function:my-func:1',
    });
    mockedLambda.listFunctionTags.mockResolvedValue({});
    mockedApigw.listDeployments.mockResolvedValue([]);
    mockedApigw.listStages.mockResolvedValue([]);
    mockedApigw.listBasePathMappings.mockResolvedValue([]);
    mockedApigw.createDeployment.mockResolvedValue({ id: 'dep1', description: 'abc1234' });
    mockedApigw.createCustomDomainMappingV2.mockResolvedValue(undefined);
});

describe('processFunctionEnvironmentVars', () => {
    it('resolves plain and !ImportValue variables onto each function', async () => {
        const results = await cicd.processFunctionEnvironmentVars();

        expect(mockedLambda.updateEnvironmentVariables).toHaveBeenCalledWith('my-func', {
            PLAIN: 'value1',
            FROM_EXPORT: 'shared-value',
        });
        expect(results).toEqual([{ name: 'my-func', updated: true, varCount: 2 }]);
    });

    it('applies stage environment overrides after setStageConfig', async () => {
        await cicd.setStageConfig('dev');
        await cicd.processFunctionEnvironmentVars();

        expect(mockedLambda.updateEnvironmentVariables).toHaveBeenCalledWith('my-func', {
            PLAIN: 'stage-override',
            FROM_EXPORT: 'shared-value',
        });
    });

    it('does not mutate AWS in dry-run mode', async () => {
        await cicd.processFunctionEnvironmentVars(true);
        expect(mockedLambda.updateEnvironmentVariables).not.toHaveBeenCalled();
    });

    it('fails when an !ImportValue reference is missing', async () => {
        fixture.environment.FROM_EXPORT = '!ImportValue DoesNotExist';
        await expect(cicd.processFunctionEnvironmentVars()).rejects.toThrow(
            /Failed to resolve 1 environment variable/
        );
    });

    it('resetForTest isolates resolved state between runs', async () => {
        await cicd.processFunctionEnvironmentVars();
        expect(mockedLambda.updateEnvironmentVariables).toHaveBeenLastCalledWith('my-func', expect.objectContaining({ PLAIN: 'value1' }));

        cicd.resetForTest();
        fixture = freshFixture();
        fixture.environment.PLAIN = 'changed';
        await cicd.processFunctionEnvironmentVars();
        expect(mockedLambda.updateEnvironmentVariables).toHaveBeenLastCalledWith('my-func', expect.objectContaining({ PLAIN: 'changed' }));
    });
});

describe('init / export resolution', () => {
    it('fails when a configured export is missing from CloudFormation', async () => {
        mockListExports.mockResolvedValue([{ Name: 'MyFunc', Value: 'my-func' }]);
        await expect(cicd.processFunctionEnvironmentVars()).rejects.toThrow(
            /1 export\(s\) could not be resolved/
        );
    });
});

describe('processApiGateway', () => {
    it('creates version, alias, deployment, stage, and mapping on first deploy', async () => {
        const result = await cicd.processApiGateway('dev', 'myapp-abc1234', 'abc1234');

        expect(mockedLambda.publishNewVersion).toHaveBeenCalledWith('my-func', 'myapp-abc1234');
        expect(mockedLambda.createAlias).toHaveBeenCalledWith('my-func', 'myapp-abc1234', '1');
        expect(mockedApigw.createDeployment).toHaveBeenCalledWith('api123', 'abc1234');
        expect(mockedApigw.createStage).toHaveBeenCalledWith('api123', 'dev', 'dep1', 'myapp-abc1234', null);
        expect(mockedApigw.createCustomDomainMappingV2).toHaveBeenCalledWith('api.example.com', 'api123', 'dev', 'dev');
        expect(mockedLambda.addFunctionPermission).toHaveBeenCalledWith(
            'arn:aws:lambda:us-east-1:123456789012:function:my-func:myapp-abc1234',
            'arn:aws:execute-api:us-east-1:123456789012:api123/*/ANY/*',
            'apigateway.amazonaws.com'
        );

        expect(result.functions).toEqual([{ name: 'my-func', action: 'created', version: '1' }]);
        expect(result.apis[0]).toMatchObject({
            name: 'MyApi',
            deployment: 'created',
            stage: 'created',
            mapping: 'created',
        });
    });

    it('reuses existing deployment, stage, and mapping on redeploy', async () => {
        mockedApigw.listDeployments.mockResolvedValue([{ id: 'dep0', description: 'abc1234' }]);
        mockedApigw.listStages.mockResolvedValue([{ stageName: 'dev' }]);
        mockedApigw.listBasePathMappings.mockResolvedValue([
            { restApiId: 'api123', stage: 'dev', basePath: 'dev' },
        ]);
        mockedLambda.listAliases.mockResolvedValue([
            { alias: 'myapp-abc1234', version: '1', description: undefined },
        ]);

        const result = await cicd.processApiGateway('dev', 'myapp-abc1234', 'abc1234');

        expect(mockedApigw.createDeployment).not.toHaveBeenCalled();
        expect(mockedApigw.createStage).not.toHaveBeenCalled();
        expect(mockedApigw.updateStage).toHaveBeenCalledWith('api123', 'dev', 'dep0', 'myapp-abc1234', null);
        expect(mockedApigw.createCustomDomainMappingV2).not.toHaveBeenCalled();

        expect(result.functions[0].action).toBe('exists');
        expect(result.apis[0]).toMatchObject({
            deployment: 'existing',
            stage: 'updated',
            mapping: 'existing',
        });
    });

    it('treats a ConflictException on mapping creation as already-existing', async () => {
        mockedApigw.createCustomDomainMappingV2.mockRejectedValue(
            Object.assign(new Error('exists'), { name: 'ConflictException' })
        );

        const result = await cicd.processApiGateway('dev', 'myapp-abc1234', 'abc1234');
        expect(result.apis[0].mapping).toBe('existing');
    });

    it('fails the deploy when mapping creation fails for any other reason', async () => {
        mockedApigw.createCustomDomainMappingV2.mockRejectedValue(
            Object.assign(new Error('domain not found'), { name: 'NotFoundException' })
        );

        await expect(cicd.processApiGateway('dev', 'myapp-abc1234', 'abc1234')).rejects.toThrow('domain not found');
    });

    it('refuses to overwrite a mapping owned by a different API', async () => {
        mockedApigw.listBasePathMappings.mockResolvedValue([
            { restApiId: 'otherApi', stage: 'dev', basePath: 'dev' },
        ]);

        await expect(cicd.processApiGateway('dev', 'myapp-abc1234', 'abc1234')).rejects.toThrow(/already mapped to a different api/);
        expect(mockedApigw.createCustomDomainMappingV2).not.toHaveBeenCalled();
    });

    it('does not mutate AWS in dry-run mode', async () => {
        const result = await cicd.processApiGateway('dev', 'myapp-abc1234', 'abc1234', undefined, true);

        expect(mockedLambda.publishNewVersion).not.toHaveBeenCalled();
        expect(mockedApigw.createDeployment).not.toHaveBeenCalled();
        expect(mockedApigw.createStage).not.toHaveBeenCalled();
        expect(mockedApigw.createCustomDomainMappingV2).not.toHaveBeenCalled();
        expect(result.apis[0].throttle).toBe('dry-run');
    });
});

describe('processSNS stage filtering', () => {
    it('requires setStageConfig before deploying a stage-filtered topic', async () => {
        fixture.exports.push({
            name: 'MyTopic',
            type: 'sns',
            stages: ['dev'],
            functions: [],
        });
        mockListExports.mockResolvedValue([
            { Name: 'MyApi', Value: 'api123' },
            { Name: 'MyFunc', Value: 'my-func' },
            { Name: 'SharedExport', Value: 'shared-value' },
            { Name: 'MyTopic', Value: 'arn:aws:sns:us-east-1:123456789012:my-topic' },
        ]);

        await expect(cicd.processSNS('dev', 'myapp-abc1234', 'abc1234')).rejects.toThrow(/stageConfig not set/);
    });
});
