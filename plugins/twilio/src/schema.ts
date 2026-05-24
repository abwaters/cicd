export const stageSchema = {
    type: 'object',
    description: 'Twilio webhook configuration for this stage. Accepts a phone number SID (PNxxxxxxxx) or messaging service SID (MGxxxxxxxx).',
    required: ['messagingSid', 'smsWebhookApi'],
    properties: {
        messagingSid: {
            type: 'string',
            description: 'Twilio phone number SID (PNxxxxxxxx) or messaging service SID (MGxxxxxxxx). Supports !ImportValue, !ParameterStore, !SetEnv.',
            pattern: '^(PN|MG)[a-f0-9]{32}$|^!',
        },
        smsWebhookApi: {
            type: 'string',
            description: 'Name of the API export to use for building the SMS webhook URL',
            minLength: 1,
        },
    },
    additionalProperties: false,
};
