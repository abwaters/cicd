// Mocks must be hoisted via jest.mock — declared before the imports they affect.
jest.mock('../src/shared/config', () => ({
    getConfig: jest.fn(),
    initConfig: jest.fn(),
}));

const mockSend = jest.fn();
const mockRegionProvider = jest.fn();
jest.mock('@aws-sdk/client-sts', () => ({
    STSClient: jest.fn().mockImplementation(() => ({
        send: mockSend,
        config: { region: mockRegionProvider },
    })),
    GetCallerIdentityCommand: jest.fn().mockImplementation((input: any) => ({ input })),
}));

import { getRegion, getAccount, resetForTest } from '../src/shared/aws-context';
import * as config from '../src/shared/config';

const mockGetConfig = config.getConfig as unknown as jest.Mock;

const SAVED_ENV = { ...process.env };

function clearAwsEnv() {
    delete process.env.AWS_REGION;
    delete process.env.AWS_DEFAULT_REGION;
    delete process.env.AWS_PROFILE;
}

beforeEach(() => {
    resetForTest();
    mockGetConfig.mockReset();
    mockSend.mockReset();
    mockRegionProvider.mockReset();
    process.env = { ...SAVED_ENV };
    clearAwsEnv();
});

afterAll(() => {
    process.env = SAVED_ENV;
});

describe('getRegion', () => {
    it('returns cicd.json region when set', async () => {
        mockGetConfig.mockImplementation(async (k: string) => (k === 'region' ? 'us-west-2' : undefined));
        await expect(getRegion()).resolves.toBe('us-west-2');
        expect(mockRegionProvider).not.toHaveBeenCalled();
    });

    it('falls back to AWS_REGION when cicd.json has none', async () => {
        mockGetConfig.mockResolvedValue(undefined);
        process.env.AWS_REGION = 'eu-west-1';
        await expect(getRegion()).resolves.toBe('eu-west-1');
    });

    it('falls back to AWS_DEFAULT_REGION when AWS_REGION is unset', async () => {
        mockGetConfig.mockResolvedValue(undefined);
        process.env.AWS_DEFAULT_REGION = 'ap-south-1';
        await expect(getRegion()).resolves.toBe('ap-south-1');
    });

    it('falls back to SDK provider (profile) as last resort', async () => {
        mockGetConfig.mockResolvedValue(undefined);
        mockRegionProvider.mockResolvedValue('us-east-2');
        await expect(getRegion()).resolves.toBe('us-east-2');
    });

    it('throws a clear error when no source provides a region', async () => {
        mockGetConfig.mockResolvedValue(undefined);
        mockRegionProvider.mockRejectedValue(new Error('Region is missing'));
        await expect(getRegion()).rejects.toThrow(/AWS region could not be determined/);
    });

    it('caches the resolved region across calls', async () => {
        mockGetConfig.mockImplementation(async (k: string) => (k === 'region' ? 'us-west-2' : undefined));
        await getRegion();
        await getRegion();
        expect(mockGetConfig).toHaveBeenCalledTimes(1);
    });
});

describe('getAccount', () => {
    function setupRegion(value = 'us-east-1') {
        mockGetConfig.mockImplementation(async (k: string) => {
            if (k === 'region') return value;
            return undefined;
        });
    }

    it('returns STS account when cicd.json has no pin', async () => {
        setupRegion();
        mockSend.mockResolvedValue({ Account: '123456789012' });
        await expect(getAccount()).resolves.toBe('123456789012');
    });

    it('returns STS account when cicd.json pin matches', async () => {
        mockGetConfig.mockImplementation(async (k: string) => {
            if (k === 'region') return 'us-east-1';
            if (k === 'account') return '123456789012';
            return undefined;
        });
        mockSend.mockResolvedValue({ Account: '123456789012' });
        await expect(getAccount()).resolves.toBe('123456789012');
    });

    it('throws on account-pin mismatch', async () => {
        mockGetConfig.mockImplementation(async (k: string) => {
            if (k === 'region') return 'us-east-1';
            if (k === 'account') return '111111111111';
            return undefined;
        });
        mockSend.mockResolvedValue({ Account: '222222222222' });
        await expect(getAccount()).rejects.toThrow(/Account mismatch.*111111111111.*222222222222/s);
    });

    it('includes AWS_PROFILE in mismatch error when set', async () => {
        process.env.AWS_PROFILE = 'dev-account';
        mockGetConfig.mockImplementation(async (k: string) => {
            if (k === 'region') return 'us-east-1';
            if (k === 'account') return '111111111111';
            return undefined;
        });
        mockSend.mockResolvedValue({ Account: '222222222222' });
        await expect(getAccount()).rejects.toThrow(/AWS_PROFILE=dev-account/);
    });

    it('throws when STS returns no Account field', async () => {
        setupRegion();
        mockSend.mockResolvedValue({});
        await expect(getAccount()).rejects.toThrow(/no Account field/);
    });

    it('caches the resolved account across calls', async () => {
        setupRegion();
        mockSend.mockResolvedValue({ Account: '123456789012' });
        await getAccount();
        await getAccount();
        expect(mockSend).toHaveBeenCalledTimes(1);
    });
});
