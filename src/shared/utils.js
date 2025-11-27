const SLEEP_TIME = 1000;
async function sleep(ms) {
    if( !ms ) {
        ms = SLEEP_TIME;
    }
    return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = {sleep};