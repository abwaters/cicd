let isVerbose = false;

function setVerbose(enabled: boolean): void {
    isVerbose = enabled;
}

function verbose(...args: unknown[]): void {
    if (isVerbose) {
        console.log(...args);
    }
}

function log(...args: unknown[]): void {
    console.log(...args);
}

function error(...args: unknown[]): void {
    console.error(...args);
}

export { setVerbose, verbose, log, error };
