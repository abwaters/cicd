export interface TwilioStageConfig {
    messagingSid: string;
    smsWebhookApi: string;
}

export interface TwilioPhoneResult {
    sid: string;
    phoneNumber: string;
    smsUrl: string;
}

export interface TwilioPhoneInfo {
    sid: string;
    phoneNumber: string;
    friendlyName: string;
    smsUrl: string;
    smsMethod: string;
}

export interface TwilioMessagingResult {
    sid: string;
    friendlyName: string;
    inboundRequestUrl: string;
}

export interface TwilioMessagingInfo {
    sid: string;
    friendlyName: string;
    inboundRequestUrl: string;
    inboundMethod: string;
}
