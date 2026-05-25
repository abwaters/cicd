import { execSync } from 'child_process';

const SLEEP_TIME = 1000;

// Resolve the subject line (first line) of a commit message so deployments can
// default to a meaningful description. Returns null if git is unavailable or the
// commit can't be resolved locally (callers fall back to a generated string).
function getCommitSubject(commit: string): string | null {
    try {
        const subject = execSync(`git log -1 --format=%s ${commit}`, {
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'pipe'],
        }).trim();
        return subject || null;
    } catch {
        return null;
    }
}

async function sleep(ms?: number): Promise<void> {
    if( !ms ) {
        ms = SLEEP_TIME;
    }
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Adaptive throttle retry infrastructure
let adaptiveDelay = 0;
const MAX_DELAY = 30000;
const MIN_THROTTLE_DELAY = 500;
const DECAY_FACTOR = 0.7;
const BACKOFF_FACTOR = 2;
const MAX_RETRIES = 8;

interface AWSError extends Error {
    code?: string;
    $metadata?: { httpStatusCode?: number };
}

function isThrottleError(error: unknown): boolean {
    if (!error) return false;
    const err = error as AWSError;
    const throttleNames = [
        'TooManyRequestsException',
        'ThrottlingException',
        'Throttling',
        'RequestLimitExceeded'
    ];
    if (throttleNames.includes(err.name)) return true;
    if (err.$metadata && err.$metadata.httpStatusCode === 429) return true;
    if (err.code && throttleNames.includes(err.code)) return true;
    return false;
}

async function awsRetry<T>(operation: () => Promise<T>, maxRetries?: number): Promise<T> {
    if (maxRetries === undefined) maxRetries = MAX_RETRIES;
    let throttled = false;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        // Apply adaptive delay before each call
        if (adaptiveDelay > 0) {
            const jitter = Math.random() * adaptiveDelay * 0.2;
            await sleep(Math.floor(adaptiveDelay + jitter));
        }

        try {
            const result = await operation();
            // On success, decay delay toward 0
            adaptiveDelay = Math.floor(adaptiveDelay * DECAY_FACTOR);
            if (adaptiveDelay < 10) adaptiveDelay = 0;
            if (throttled) process.stdout.write('\n');
            return result;
        } catch (error) {
            if (isThrottleError(error) && attempt < maxRetries) {
                // Increase delay on throttle
                adaptiveDelay = Math.min(
                    Math.max(adaptiveDelay * BACKOFF_FACTOR, MIN_THROTTLE_DELAY),
                    MAX_DELAY
                );
                process.stdout.write('.');
                throttled = true;
                continue;
            }
            if (throttled) process.stdout.write('\n');
            throw error;
        }
    }

    // Should not reach here, but TypeScript needs a return
    throw new Error('Max retries exceeded');
}

const NETWORK_ERROR_CODES = new Set([
    'ENOTFOUND',      // DNS resolution failed
    'EAI_AGAIN',      // DNS temporarily unavailable
    'ETIMEDOUT',      // connection timed out
    'ECONNREFUSED',   // connection refused
    'ECONNRESET',     // connection reset by peer
    'ENETUNREACH',    // network unreachable
    'EHOSTUNREACH',   // host unreachable
    'EPIPE'           // broken pipe
]);

function isNetworkError(error: unknown): boolean {
    if (!error) return false;
    const err = error as AWSError & { syscall?: string };
    if (err.code && NETWORK_ERROR_CODES.has(err.code)) return true;
    // AWS SDK sometimes wraps the cause
    const cause = (err as any).cause;
    if (cause && cause.code && NETWORK_ERROR_CODES.has(cause.code)) return true;
    return false;
}

function describeNetworkError(error: unknown): string {
    const err = error as AWSError & { hostname?: string; syscall?: string };
    const cause = (err as any).cause;
    const code = err.code || (cause && cause.code) || 'unknown';
    const hostname = err.hostname || (cause && cause.hostname);
    const attempts = err.$metadata && (err.$metadata as any).attempts;
    const parts: string[] = [`Network error (${code})`];
    if (hostname) parts.push(`could not reach ${hostname}`);
    if (attempts) parts.push(`after ${attempts} attempt${attempts === 1 ? '' : 's'}`);
    parts.push('— check your internet connection or VPN and retry');
    return parts.join(' ');
}

function formatDuration(totalSeconds: number): string {
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    if (hours > 0) {
        return `${hours}h ${minutes}m ${seconds}s`;
    }
    if (minutes > 0) {
        return `${minutes}m ${seconds}s`;
    }
    return `${seconds}s`;
}

export { sleep, awsRetry, isThrottleError, isNetworkError, describeNetworkError, formatDuration, getCommitSubject };
