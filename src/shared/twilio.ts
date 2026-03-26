import { TwilioPhoneResult, TwilioPhoneInfo, TwilioMessagingResult, TwilioMessagingInfo } from '../types';

const Twilio = require('twilio');

async function updatePhoneNumberWebhook(accountSid: string, authToken: string, phoneNumberSid: string, smsUrl: string): Promise<TwilioPhoneResult> {
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

async function getPhoneNumber(accountSid: string, authToken: string, phoneNumberSid: string): Promise<TwilioPhoneInfo> {
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

async function updateMessagingServiceWebhook(accountSid: string, authToken: string, messagingServiceSid: string, inboundRequestUrl: string): Promise<TwilioMessagingResult> {
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

async function getMessagingService(accountSid: string, authToken: string, messagingServiceSid: string): Promise<TwilioMessagingInfo> {
    const client = Twilio(accountSid, authToken);
    const result = await client.messaging.v1.services(messagingServiceSid).fetch();
    return {
        sid: result.sid,
        friendlyName: result.friendlyName,
        inboundRequestUrl: result.inboundRequestUrl,
        inboundMethod: result.inboundMethod
    };
}

function isMessagingServiceSid(sid: string): boolean {
    return !!sid && sid.startsWith('MG');
}

module.exports = { updatePhoneNumberWebhook, getPhoneNumber, updateMessagingServiceWebhook, getMessagingService, isMessagingServiceSid };
