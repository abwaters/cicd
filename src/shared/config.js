const fs = require('fs');

let rawConfig = null;

async function initConfig(options) {
    if( !rawConfig ) {
        const data = fs.readFileSync("./cicd.json",{encoding:"utf8"});
        rawConfig = JSON.parse(data);
    }
}

async function getConfig(key) {
    await initConfig();
    return rawConfig[key];
}

module.exports = {initConfig,getConfig}