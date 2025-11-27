const {getParameterValue} = require("./shared/ps");

async function main() {
    const gcal_credentials = await getParameterValue("/ccfw/prod/service/gcal_credentials");
    console.log(gcal_credentials);
}

main();
