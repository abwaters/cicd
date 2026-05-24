import Twilio from 'twilio';
import {
    TwilioPhoneResult,
    TwilioPhoneInfo,
    TwilioMessagingResult,
    TwilioMessagingInfo,
} from './types';

export async function updatePhoneNumberWebhook(accountSid: string, authToken: string, phoneNumberSid: string, smsUrl: string): Promise<TwilioPhoneResult> {
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

export async function getPhoneNumber(accountSid: string, authToken: string, phoneNumberSid: string): Promise<TwilioPhoneInfo> {
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

export async function updateMessagingServiceWebhook(accountSid: string, authToken: string, messagingServiceSid: string, inboundRequestUrl: string): Promise<TwilioMessagingResult> {
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

export async function getMessagingService(accountSid: string, authToken: string, messagingServiceSid: string): Promise<TwilioMessagingInfo> {
    const client = Twilio(accountSid, authToken);
    const result = await client.messaging.v1.services(messagingServiceSid).fetch();
    return {
        sid: result.sid,
        friendlyName: result.friendlyName,
        inboundRequestUrl: result.inboundRequestUrl,
        inboundMethod: result.inboundMethod
    };
}

export function isMessagingServiceSid(sid: string): boolean {
    return !!sid && sid.startsWith('MG');
}
