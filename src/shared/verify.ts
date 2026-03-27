import * as cicd from './cicd';
import * as apigw from './apigw';
import * as sns from './sns';
import * as logger from './logger';

export interface VerificationResult {
    passed: boolean;
    checks: VerificationCheck[];
}

export interface VerificationCheck {
    type: 'api' | 'sns';
    name: string;
    expected: string;
    actual: string;
    passed: boolean;
}

async function verifyDeployment(stage: string, appAlias: string): Promise<VerificationResult> {
    const checks: VerificationCheck[] = [];

    // Verify API Gateway stage variables
    const apis = await cicd.getExportsByType('api');
    for (const api of apis) {
        const apiId = api.value!;
        const stages = await apigw.listStages(apiId);
        const stageInfo = stages.find((s: any) => s.stageName === stage);
        const actual = stageInfo?.variables?.Commit || '(not set)';
        checks.push({
            type: 'api',
            name: api.name,
            expected: appAlias,
            actual,
            passed: actual === appAlias
        });
    }

    // Verify SNS subscriptions
    const stageConfig = await cicd.getConfig('stages');
    const currentStage = stageConfig.find((s: any) => s.stage === stage);
    const topics = await cicd.getExportsByType('sns');
    for (const topic of topics) {
        // Skip topics not configured for this stage
        if (topic.stages && !topic.stages.includes(stage)) {
            continue;
        }

        const subs = await sns.listSubscriptionsByTopic(topic.value!);
        let foundAlias = '(no subscription)';
        for (const sub of subs) {
            if (sub.protocol === 'lambda') {
                const parts = sub.endpoint.split(':');
                if (parts.length === 8) {
                    foundAlias = parts[7];
                    break;
                }
            }
        }
        checks.push({
            type: 'sns',
            name: topic.name,
            expected: appAlias,
            actual: foundAlias,
            passed: foundAlias === appAlias
        });
    }

    return {
        passed: checks.every(c => c.passed),
        checks
    };
}

function printVerificationResult(result: VerificationResult): void {
    console.log(`\nDeployment Verification:`);
    for (const check of result.checks) {
        const icon = check.passed ? '✓' : '✗';
        const label = check.type === 'api' ? 'API' : 'SNS';
        if (check.passed) {
            console.log(`  ${icon} ${label} ${check.name.padEnd(35)} ${check.actual}`);
        } else {
            console.log(`  ${icon} ${label} ${check.name.padEnd(35)} expected '${check.expected}', got '${check.actual}'`);
        }
    }
    if (result.passed) {
        console.log(`  All checks passed.`);
    } else {
        const failed = result.checks.filter(c => !c.passed).length;
        console.log(`  WARNING: ${failed} check(s) failed.`);
    }
}

export { verifyDeployment, printVerificationResult };
