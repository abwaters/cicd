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

/**
 * Updates the inbound request URL for a Twilio Messaging Service
 * @param {string} accountSid - Twilio account SID
 * @param {string} authToken - Twilio auth token
 * @param {string} messagingServiceSid - Messaging Service SID (MGxxxxxxxx)
 * @param {string} inboundRequestUrl - Webhook URL for incoming messages
 * @returns {Promise<{sid: string, friendlyName: string, inboundRequestUrl: string}>}
 */
async function updateMessagingServiceWebhook(accountSid, authToken, messagingServiceSid, inboundRequestUrl) {
    const client = Twilio(accountSid, authToken);
    const result = await client.messaging.v1.services(messagingServiceSid).update({
        inboundRequestUrl,
        inboundMethod: 'POST'
    });
    return {
        sid: result.sid,
        friendlyName: result.friendlyName,
        inboundRequestUrl: result.inboundRequestUrl
    };
}

/**
 * Fetches details for a Twilio Messaging Service
 * @param {string} accountSid - Twilio account SID
 * @param {string} authToken - Twilio auth token
 * @param {string} messagingServiceSid - Messaging Service SID (MGxxxxxxxx)
 * @returns {Promise<{sid: string, friendlyName: string, inboundRequestUrl: string, inboundMethod: string}>}
 */
async function getMessagingService(accountSid, authToken, messagingServiceSid) {
    const client = Twilio(accountSid, authToken);
    const result = await client.messaging.v1.services(messagingServiceSid).fetch();
    return {
        sid: result.sid,
        friendlyName: result.friendlyName,
        inboundRequestUrl: result.inboundRequestUrl,
        inboundMethod: result.inboundMethod
    };
}

/**
 * Checks if a SID is a Messaging Service SID (MG prefix)
 */
function isMessagingServiceSid(sid) {
    return sid && sid.startsWith('MG');
}

module.exports = { updatePhoneNumberWebhook, getPhoneNumber, updateMessagingServiceWebhook, getMessagingService, isMessagingServiceSid };
