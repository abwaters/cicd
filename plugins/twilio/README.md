# @abwaters/cicd-plugin-twilio

Twilio webhook plugin for [`@abwaters/cicd`](https://github.com/abwaters/cicd).

During `deploy` and `rollback`, this plugin points a Twilio phone number's SMS webhook (or a messaging service's inbound webhook) at the deployed API Gateway URL for the stage. During `info --verbose`, it reports the current webhook configuration.

## Install

```bash
npm install @abwaters/cicd-plugin-twilio
```

Then add it to your `cicd.json`:

```json
{
  "plugins": ["@abwaters/cicd-plugin-twilio"],
  "stages": [
    {
      "stage": "prod",
      "mapping": { "domain": "api.example.com", "path": "" },
      "twilio": {
        "messagingSid": "MGxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
        "smsWebhookApi": "myapp-sms-api"
      }
    }
  ]
}
```

`messagingSid` accepts a Twilio phone number SID (`PN...`) or a messaging service SID (`MG...`), and supports the standard `!ImportValue`, `!ParameterStore`, and `!SetEnv` prefixes for runtime resolution.

`smsWebhookApi` must be the `name` of an `api` export in `cicd.json`; the plugin composes the webhook URL from that API's stage mapping.

## Credentials

Set in the environment of whoever runs `cicd deploy`:

```
TWILIO_ACCOUNT_SID=AC...
TWILIO_AUTH_TOKEN=...
```

If either is missing, the plugin logs a verbose-mode skip and does nothing — useful for stages that aren't using Twilio.

## CLI flags

- `--no-twilio` — skip the plugin for a single invocation, even when listed
- `--env`, `--api`, `--sns`, `--sqs`, `--workers`, `--web` — all auto-skip plugins (existing core behavior)

## Build

```bash
npm install
npm run build
```
