import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";

import * as awsContext from './aws-context';

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

            console.error('\nError: AWS credentials are not configured.\n');
            console.error('To use this tool, you must configure AWS credentials using one of these methods:\n');
            console.error('1. Environment variables:');
            console.error('   - AWS_ACCESS_KEY_ID');
            console.error('   - AWS_SECRET_ACCESS_KEY');
            console.error('   - AWS_SESSION_TOKEN (optional, for temporary credentials)\n');
            console.error('2. AWS Profile (using AWS_PROFILE environment variable):');
            console.error('   - Set AWS_PROFILE to the name of a profile in ~/.aws/credentials\n');
            console.error('3. AWS credentials file:');
            console.error('   - Configure default credentials in ~/.aws/credentials\n');
            console.error('For more information, visit:');
            console.error('https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-files.html\n');

            process.exit(1);
        } else if (error.name === 'UnrecognizedClientException' ||
                   error.message?.includes('security token') ||
                   error.message?.includes('not authorized')) {

            console.error('\nError: AWS credentials are invalid or expired.\n');
            console.error('Please check your AWS credentials and try again.\n');
            if (process.env.AWS_PROFILE) {
                console.error(`Current AWS_PROFILE: ${process.env.AWS_PROFILE}\n`);
            }

            process.exit(1);
        } else {
            // Some other error occurred
            console.error('\nError validating AWS credentials:', error.message);
            process.exit(1);
        }
    }

    return false;
}

export { validateCredentials };
