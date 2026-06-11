import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";

import * as awsContext from './aws-context';

// Thrown when AWS credentials are missing/invalid. The message carries the
// full remediation text; index.ts prints it and sets the exit code.
class CredentialsError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'CredentialsError';
    }
}

async function validateCredentials(): Promise<boolean> {
    try {
        const region = await awsContext.getRegion();
        const client = new STSClient({ region });

        // Attempt to get caller identity - this will fail if credentials aren't configured
        const command = new GetCallerIdentityCommand({});
        await client.send(command);

        return true;
    } catch (error: any) {
        // Handle different types of credential errors
        if (error.name === 'CredentialsProviderError' ||
            error.message?.includes('Could not load credentials') ||
            error.message?.includes('Unable to load credentials')) {

            throw new CredentialsError([
                'AWS credentials are not configured.',
                '',
                'To use this tool, you must configure AWS credentials using one of these methods:',
                '',
                '1. Environment variables:',
                '   - AWS_ACCESS_KEY_ID',
                '   - AWS_SECRET_ACCESS_KEY',
                '   - AWS_SESSION_TOKEN (optional, for temporary credentials)',
                '',
                '2. AWS Profile (using AWS_PROFILE environment variable):',
                '   - Set AWS_PROFILE to the name of a profile in ~/.aws/credentials',
                '',
                '3. AWS credentials file:',
                '   - Configure default credentials in ~/.aws/credentials',
                '',
                'For more information, visit:',
                'https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-files.html',
            ].join('\n'));
        } else if (error.name === 'UnrecognizedClientException' ||
                   error.message?.includes('security token') ||
                   error.message?.includes('not authorized')) {

            const profileHint = process.env.AWS_PROFILE
                ? `\n\nCurrent AWS_PROFILE: ${process.env.AWS_PROFILE}`
                : '';
            throw new CredentialsError(
                `AWS credentials are invalid or expired.\n\nPlease check your AWS credentials and try again.${profileHint}`
            );
        } else {
            throw new CredentialsError(`Error validating AWS credentials: ${error.message}`);
        }
    }
}

export { validateCredentials, CredentialsError };
