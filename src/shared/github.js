const { execSync } = require('child_process');
const logger = require('./logger');

let ghAvailable = null;

/**
 * Check if the gh CLI is installed and available
 */
function isGhAvailable() {
    if (ghAvailable !== null) return ghAvailable;
    try {
        execSync('gh --version', { stdio: 'ignore' });
        ghAvailable = true;
    } catch {
        ghAvailable = false;
    }
    return ghAvailable;
}

/**
 * Run a gh api command and return parsed JSON
 */
function ghApi(method, path, body) {
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

/**
 * Create a GitHub deployment
 * @param {string} repo - owner/repo format
 * @param {string} ref - git ref (commit SHA)
 * @param {string} environment - deployment environment name (e.g., staging, prod)
 * @param {string} description - deployment description
 * @returns {object|null} deployment object with id, or null if skipped
 */
function createDeployment(repo, ref, environment, description) {
    if (!isGhAvailable()) {
        logger.verbose(`   - gh CLI not installed, skipping GitHub deployment tracking`);
        return null;
    }

    try {
        // Use --input with JSON body because required_contexts must be an empty array
        const body = JSON.stringify({
            ref,
            environment,
            description,
            auto_merge: false,
            required_contexts: []
        });
        const cmd = `gh api -X POST /repos/${repo}/deployments -H "Accept: application/vnd.github+json" --input -`;
        logger.verbose(`   - gh api: POST /repos/${repo}/deployments`);
        const result = execSync(cmd, { input: body, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
        const deployment = JSON.parse(result);
        logger.verbose(`   - created GitHub deployment #${deployment.id} for ${environment}`);
        return deployment;
    } catch (e) {
        logger.verbose(`   - failed to create GitHub deployment: ${e.message}`);
        return null;
    }
}

/**
 * Update a GitHub deployment status
 * @param {string} repo - owner/repo format
 * @param {number} deploymentId - deployment ID
 * @param {string} state - status state (in_progress, success, failure, error)
 * @param {string} description - status description
 * @returns {object|null} status object, or null if skipped
 */
function updateDeploymentStatus(repo, deploymentId, state, description) {
    if (!isGhAvailable()) {
        return null;
    }

    try {
        const result = ghApi('POST', `/repos/${repo}/deployments/${deploymentId}/statuses`, {
            state,
            description
        });
        logger.verbose(`   - deployment #${deploymentId} status: ${state}`);
        return result;
    } catch (e) {
        logger.verbose(`   - failed to update deployment status: ${e.message}`);
        return null;
    }
}

/**
 * List recent deployments for an environment
 * @param {string} repo - owner/repo format
 * @param {string} environment - environment name
 * @param {number} count - number of deployments to return (default 5)
 * @returns {Array} array of deployment objects with status info
 */
function listDeployments(repo, environment, count = 5) {
    if (!isGhAvailable()) {
        logger.verbose(`   - gh CLI not installed, skipping GitHub deployment history`);
        return [];
    }

    try {
        const deployments = ghApi('GET', `/repos/${repo}/deployments?environment=${environment}&per_page=${count}`);
        const results = [];
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
    } catch (e) {
        logger.verbose(`   - failed to list GitHub deployments: ${e.message}`);
        return [];
    }
}

module.exports = {
    isGhAvailable,
    createDeployment,
    updateDeploymentStatus,
    listDeployments
};
