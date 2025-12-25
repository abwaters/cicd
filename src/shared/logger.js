/**
 * Simple logger with verbosity control
 */
let isVerbose = false;

/**
 * Set verbose mode
 * @param {boolean} verbose - Enable verbose logging
 */
function setVerbose(verbose) {
    isVerbose = verbose;
}

/**
 * Log a message only if verbose mode is enabled
 * @param {string} message - The message to log
 */
function verbose(...args) {
    if (isVerbose) {
        console.log(...args);
    }
}

/**
 * Always log a message (standard output)
 * @param {string} message - The message to log
 */
function log(...args) {
    console.log(...args);
}

/**
 * Log an error message
 * @param {string} message - The error message to log
 */
function error(...args) {
    console.error(...args);
}

module.exports = {
    setVerbose,
    verbose,
    log,
    error
};
