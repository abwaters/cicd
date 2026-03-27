const SLEEP_TIME = 1000;

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

export { sleep, awsRetry, isThrottleError };
