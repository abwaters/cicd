import { execSync } from 'child_process';
import { GitHubDeployment, BranchStatus } from '../types';

import * as logger from './logger';

let ghAvailable: boolean | null = null;

function isGhAvailable(): boolean {
    if (ghAvailable !== null) return ghAvailable;
    try {
        execSync('gh --version', { stdio: 'ignore' });
        ghAvailable = true;
    } catch {
        ghAvailable = false;
    }
    return ghAvailable;
}

function ghApi(method: string, path: string, body?: Record<string, string | boolean | number>): any {
    const args = ['gh', 'api', '-X', method, path, '-H', 'Accept: application/vnd.github+json'];
    if (body) {
        for (const [key, value] of Object.entries(body)) {
            if (typeof value === 'boolean' || typeof value === 'number') {
                args.push('-F', `${key}=${value}`);
            } else {
                args.push('-f', `${key}=${value}`);
            }
        }
    }

    const cmd = args.map(a => /[ &|<>^]/.test(a) ? `"${a}"` : a).join(' ');
    logger.verbose(`   - gh api: ${method} ${path}`);
    const result = execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    return JSON.parse(result);
}

// GitHub caps deployment and deployment-status `description` at 140 chars and
// rejects longer payloads with HTTP 422. Truncate before sending so we never
// fail silently and leave a deployment stuck at `in_progress`.
function truncateDescription(description: string): string {
    const MAX = 140;
    if (description.length <= MAX) return description;
    return description.slice(0, MAX - 1) + '…';
}

function createDeployment(
    repo: string,
    ref: string,
    environment: string,
    description: string,
    opts: { productionEnvironment?: boolean; transientEnvironment?: boolean } = {}
): { id: number } | null {
    if (!isGhAvailable()) {
        logger.verbose(`   - gh CLI not installed, skipping GitHub deployment tracking`);
        return null;
    }

    try {
        const body = JSON.stringify({
            ref,
            environment,
            description: truncateDescription(description),
            auto_merge: false,
            required_contexts: [],
            production_environment: !!opts.productionEnvironment,
            transient_environment: !!opts.transientEnvironment
        });
        const cmd = `gh api -X POST /repos/${repo}/deployments -H "Accept: application/vnd.github+json" --input -`;
        logger.verbose(`   - gh api: POST /repos/${repo}/deployments`);
        const result = execSync(cmd, { input: body, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
        const deployment = JSON.parse(result);
        logger.verbose(`   - created GitHub deployment #${deployment.id} for ${environment}`);
        return deployment;
    } catch (e: any) {
        console.warn(`   ! failed to create GitHub deployment: ${e.message}`);
        return null;
    }
}

function updateDeploymentStatus(repo: string, deploymentId: number, state: string, description: string): any | null {
    if (!isGhAvailable()) {
        return null;
    }

    try {
        const result = ghApi('POST', `/repos/${repo}/deployments/${deploymentId}/statuses`, {
            state,
            description: truncateDescription(description)
        });
        logger.verbose(`   - deployment #${deploymentId} status: ${state}`);
        return result;
    } catch (e: any) {
        console.warn(`   ! failed to update deployment #${deploymentId} status to '${state}': ${e.message}`);
        return null;
    }
}

function listDeployments(repo: string, environment: string, count: number = 5): GitHubDeployment[] {
    if (!isGhAvailable()) {
        logger.verbose(`   - gh CLI not installed, skipping GitHub deployment history`);
        return [];
    }

    try {
        const deployments = ghApi('GET', `/repos/${repo}/deployments?environment=${environment}&per_page=${count}`);
        const results: GitHubDeployment[] = [];
        for (const d of deployments) {
            let status = 'unknown';
            let statusDesc = '';
            try {
                const statuses = ghApi('GET', `/repos/${repo}/deployments/${d.id}/statuses`);
                if (statuses.length > 0) {
                    status = statuses[0].state;
                    statusDesc = statuses[0].description || '';
                }
            } catch {
                // ignore status fetch errors
            }
            results.push({
                id: d.id,
                ref: d.sha ? d.sha.substring(0, 7) : d.ref,
                environment: d.environment,
                description: d.description || '',
                status,
                statusDescription: statusDesc,
                createdAt: d.created_at
            });
        }
        return results;
    } catch (e: any) {
        logger.verbose(`   - failed to list GitHub deployments: ${e.message}`);
        return [];
    }
}

function getBranchTip(repo: string, branch: string): string | null {
    if (!isGhAvailable()) return null;
    try {
        const result = ghApi('GET', `/repos/${repo}/branches/${branch}`);
        return result.commit?.sha ? result.commit.sha.substring(0, 7) : null;
    } catch (e: any) {
        logger.verbose(`   - failed to get ${branch} tip: ${e.message}`);
        return null;
    }
}

function getCommitBranchStatus(repo: string, commit: string, branch: string): BranchStatus | null {
    if (!isGhAvailable()) return null;
    try {
        const r = ghApi('GET', `/repos/${repo}/compare/${branch}...${commit}`);
        const status = r.status as BranchStatus['status'];
        return {
            onMain: status === 'identical' || status === 'behind',
            isMainTip: status === 'identical',
            behindBy: r.behind_by || 0,
            aheadBy: r.ahead_by || 0,
            status,
        };
    } catch (e: any) {
        logger.verbose(`   - failed to check branch status for ${commit}: ${e.message}`);
        return null;
    }
}

export {
    isGhAvailable,
    createDeployment,
    updateDeploymentStatus,
    listDeployments,
    getBranchTip,
    getCommitBranchStatus
};
