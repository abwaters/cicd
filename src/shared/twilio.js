const Twilio = require('twilio');

/**
 * Updates the SMS webhook URL for a Twilio phone number
 * @param {string} accountSid - Twilio account SID
 * @param {string} authToken - Twilio auth token
 * @param {string} phoneNumberSid - Phone number SID (PNxxxxxxxx)
 * @param {string} smsUrl - Webhook URL for incoming SMS
 * @returns {Promise<{sid: string, phoneNumber: string, smsUrl: string}>}
 */
async function updatePhoneNumberWebhook(accountSid, authToken, phoneNumberSid, smsUrl) {
    const client = Twilio(accountSid, authToken);
    const result = await client.incomingPhoneNumbers(phoneNumberSid).update({
        smsUrl,
        smsMethod: 'POST'
    });
    return {
        sid: result.sid,
        phoneNumber: result.phoneNumber,
        smsUrl: result.smsUrl
    };
}

/**
 * Fetches details for a Twilio phone number
 * @param {string} accountSid - Twilio account SID
 * @param {string} authToken - Twilio auth token
 * @param {string} phoneNumberSid - Phone number SID (PNxxxxxxxx)
 * @returns {Promise<{sid: string, phoneNumber: string, friendlyName: string, smsUrl: string, smsMethod: string}>}
 */
async function getPhoneNumber(accountSid, authToken, phoneNumberSid) {
    const client = Twilio(accountSid, authToken);
    const result = await client.incomingPhoneNumbers(phoneNumberSid).fetch();
    return {
        sid: result.sid,
        phoneNumber: result.phoneNumber,
        friendlyName: result.friendlyName,
        smsUrl: result.smsUrl,
        smsMethod: result.smsMethod
    };
}

module.exports = { updatePhoneNumberWebhook, getPhoneNumber };
