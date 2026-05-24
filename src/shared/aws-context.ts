import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { getConfig } from './config';

// Resolve AWS account and region with sensible fallbacks so cicd.json doesn't
// have to hardcode them. Both fields stay optional in cicd.json; the value
// there acts as an explicit override (region) or a safety pin (account).

let cachedRegion: string | null = null;
let cachedAccount: string | null = null;
let stsClient: STSClient | null = null;

// Region fallback chain:
//   1. cicd.json "region"
//   2. AWS_REGION
//   3. AWS_DEFAULT_REGION
//   4. AWS profile (~/.aws/config) — via the SDK's default resolver
//   5. error with actionable message
async function getRegion(): Promise<string> {
    if (cachedRegion) return cachedRegion;

    const configRegion: string | undefined = await getConfig('region');
    if (configRegion) {
        cachedRegion = configRegion;
        return cachedRegion;
    }

    const envRegion = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION;
    if (envRegion) {
        cachedRegion = envRegion;
        return cachedRegion;
    }

    // Fall back to the SDK's default region provider, which reads
    // ~/.aws/config for the active profile (and a few other sources).
    try {
        const probe = new STSClient({});
        const resolved = await probe.config.region();
        if (resolved) {
            cachedRegion = resolved;
            return cachedRegion;
        }
    } catch {
        // fall through to the friendly error
    }

    throw new Error(
        'AWS region could not be determined.\n' +
        '  Set one of:\n' +
        '    - "region" in cicd.json\n' +
        '    - AWS_REGION environment variable\n' +
        '    - AWS_DEFAULT_REGION environment variable\n' +
        '    - "region" in your AWS profile (~/.aws/config)'
    );
}

// Account is always resolved from STS GetCallerIdentity so it follows whatever
// credentials are actually in use. cicd.json "account" acts as a safety pin:
// if it's set and doesn't match the live credentials, we hard-fail to prevent
// "oops, deployed to the wrong account."
async function getAccount(): Promise<string> {
    if (cachedAccount) return cachedAccount;

    const region = await getRegion();
    if (!stsClient) stsClient = new STSClient({ region });
    const resp = await stsClient.send(new GetCallerIdentityCommand({}));
    const actual = resp.Account;
    if (!actual) {
        throw new Error('STS GetCallerIdentity returned no Account field');
    }

    const pinned: string | undefined = await getConfig('account');
    if (pinned && pinned !== actual) {
        const profileHint = process.env.AWS_PROFILE ? ` (AWS_PROFILE=${process.env.AWS_PROFILE})` : '';
        throw new Error(
            `Account mismatch: cicd.json pins account '${pinned}' but AWS credentials resolve to '${actual}'${profileHint}.\n` +
            `  Safety check to prevent deploys to the wrong account.\n` +
            `  Fix by switching credentials, or update cicd.json "account" if intentional.`
        );
    }

    cachedAccount = actual;
    return cachedAccount;
}

// Test seam: reset the module-level caches.
function resetForTest(): void {
    cachedRegion = null;
    cachedAccount = null;
    stsClient = null;
}

export { getRegion, getAccount, resetForTest };
