const SLEEP_TIME = 1000;
async function sleep(ms) {
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

function isThrottleError(error) {
    if (!error) return false;
    const throttleNames = [
        'TooManyRequestsException',
        'ThrottlingException',
        'Throttling',
        'RequestLimitExceeded'
    ];
    if (throttleNames.includes(error.name)) return true;
    if (error.$metadata && error.$metadata.httpStatusCode === 429) return true;
    if (error.code && throttleNames.includes(error.code)) return true;
    return false;
}

async function awsRetry(operation, maxRetries) {
    if (maxRetries === undefined) maxRetries = MAX_RETRIES;

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
            return result;
        } catch (error) {
            if (isThrottleError(error) && attempt < maxRetries) {
                // Increase delay on throttle
                adaptiveDelay = Math.min(
                    Math.max(adaptiveDelay * BACKOFF_FACTOR, MIN_THROTTLE_DELAY),
                    MAX_DELAY
                );
                console.log(`Throttled (attempt ${attempt}/${maxRetries}), waiting ${adaptiveDelay}ms...`);
                continue;
            }
            throw error;
        }
    }
}

module.exports = {sleep, awsRetry, isThrottleError};
