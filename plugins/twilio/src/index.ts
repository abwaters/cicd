import type {
    CICDPlugin,
    PluginContext,
    PluginInfoContext,
    PluginResult,
} from '@abwaters/cicd';
import * as sdk from './twilio-sdk';
import { stageSchema } from './schema';
import { TwilioStageConfig } from './types';

async function resolveSid(ctx: PluginContext | PluginInfoContext, raw: string): Promise<string | null> {
    if (raw.startsWith('!')) {
        const resolved = await ctx.resolveVariable(raw);
        if (!resolved) return null;
        return resolved;
    }
    return raw;
}

function getCreds(ctx: PluginContext | PluginInfoContext): { accountSid: string; authToken: string } | null {
    const accountSid = ctx.env.TWILIO_ACCOUNT_SID;
    const authToken = ctx.env.TWILIO_AUTH_TOKEN;
    if (!accountSid || !authToken) return null;
    return { accountSid, authToken };
}

async function deployHandler(ctx: PluginContext): Promise<PluginResult | null> {
    const cfg = ctx.pluginConfig as TwilioStageConfig | undefined;
    if (!cfg) return null;

    const creds = getCreds(ctx);
    if (!creds) {
        ctx.logger.verbose(`   - Twilio credentials not found in environment, skipping`);
        return null;
    }

    const apiExport = await ctx.getExport(cfg.smsWebhookApi);
    if (!apiExport) {
        ctx.logger.verbose(`   - Twilio smsWebhookApi '${cfg.smsWebhookApi}' not found in exports, skipping`);
        return null;
    }

    const mappingPath = ctx.composeMappingPath(apiExport);
    const webhookUrl = 'https://' + ctx.stageConfig.mapping.domain + (mappingPath ? '/' + mappingPath : '');

    const sid = await resolveSid(ctx, cfg.messagingSid);
    if (!sid) {
        ctx.logger.verbose(`   - Could not resolve Twilio messagingSid, skipping`);
        return null;
    }
    const isMessagingService = sdk.isMessagingServiceSid(sid);

    if (ctx.dryRun) {
        const type = isMessagingService ? 'messaging service' : 'phone number';
        ctx.logger.verbose(`   - WOULD update Twilio ${type} ${sid} webhook to ${webhookUrl}`);
        return {
            summaryLines: [`\nTwilio:`, `  ${sid.padEnd(40)} ${webhookUrl}`],
            summaryParts: ['Twilio webhook updated'],
            raw: { messagingSid: sid, webhookUrl, action: 'updated' as const },
        };
    }

    if (isMessagingService) {
        ctx.logger.verbose(`\n * Updating Twilio messaging service webhook:`);
        ctx.logger.verbose(`   - messaging service SID: ${sid}`);
        ctx.logger.verbose(`   - webhook URL: ${webhookUrl}`);

        const result = await sdk.updateMessagingServiceWebhook(
            creds.accountSid, creds.authToken, sid, webhookUrl
        );

        ctx.logger.verbose(`   - updated ${result.friendlyName} → ${result.inboundRequestUrl}`);

        return {
            summaryLines: [`\nTwilio:`, `  ${sid.padEnd(40)} ${result.inboundRequestUrl}`],
            summaryParts: ['Twilio webhook updated'],
            raw: {
                messagingSid: sid,
                friendlyName: result.friendlyName,
                webhookUrl: result.inboundRequestUrl,
                action: 'updated' as const,
            },
        };
    } else {
        ctx.logger.verbose(`\n * Updating Twilio phone number webhook:`);
        ctx.logger.verbose(`   - phone number SID: ${sid}`);
        ctx.logger.verbose(`   - webhook URL: ${webhookUrl}`);

        const result = await sdk.updatePhoneNumberWebhook(
            creds.accountSid, creds.authToken, sid, webhookUrl
        );

        ctx.logger.verbose(`   - updated ${result.phoneNumber} → ${result.smsUrl}`);

        return {
            summaryLines: [`\nTwilio:`, `  ${sid.padEnd(40)} ${result.smsUrl}`],
            summaryParts: ['Twilio webhook updated'],
            raw: {
                messagingSid: sid,
                phoneNumber: result.phoneNumber,
                webhookUrl: result.smsUrl,
                action: 'updated' as const,
            },
        };
    }
}

async function infoHandler(ctx: PluginInfoContext): Promise<PluginResult | null> {
    const creds = getCreds(ctx);
    if (!creds) return null;

    type InfoRow = {
        stage: string;
        label: string;
        webhookUrl: string;
        type: 'messaging-service' | 'phone-number';
    };
    const rows: InfoRow[] = [];

    for (const stage of ctx.stages) {
        const cfg = (stage as any).twilio as TwilioStageConfig | undefined;
        if (!cfg) continue;
        const sid = await resolveSid(ctx, cfg.messagingSid);
        if (!sid) {
            ctx.logger.verbose(`   - Could not resolve Twilio messagingSid for stage ${stage.stage}, skipping`);
            continue;
        }
        if (sdk.isMessagingServiceSid(sid)) {
            try {
                const svc = await sdk.getMessagingService(creds.accountSid, creds.authToken, sid);
                rows.push({ stage: stage.stage, label: svc.friendlyName, webhookUrl: svc.inboundRequestUrl || 'not set', type: 'messaging-service' });
            } catch (e: any) {
                ctx.logger.verbose(`   - Error fetching messaging service ${sid}: ${e.message}`);
                rows.push({ stage: stage.stage, label: sid, webhookUrl: `error: ${e.message}`, type: 'messaging-service' });
            }
        } else {
            try {
                const phone = await sdk.getPhoneNumber(creds.accountSid, creds.authToken, sid);
                rows.push({ stage: stage.stage, label: phone.phoneNumber, webhookUrl: phone.smsUrl, type: 'phone-number' });
            } catch (e: any) {
                ctx.logger.verbose(`   - Error fetching phone number ${sid}: ${e.message}`);
                rows.push({ stage: stage.stage, label: sid, webhookUrl: `error: ${e.message}`, type: 'phone-number' });
            }
        }
    }

    if (rows.length === 0) return null;

    const labelWidth = Math.max(0, ...rows.map(r => r.label.length));
    const lines: string[] = [`\nTwilio:`];
    for (const r of rows) {
        const typeTag = r.type === 'messaging-service' ? '[svc] ' : '[num] ';
        lines.push(`  ${r.stage.padEnd(15)} ${typeTag}${r.label.padEnd(labelWidth)}  ${r.webhookUrl}`);
    }

    return { summaryLines: lines, summaryParts: [], raw: rows };
}

const plugin: CICDPlugin = {
    name: 'twilio',
    scopeFlag: 'noTwilio',
    stageSchema,
    deploy: deployHandler,
    rollback: deployHandler,
    info: infoHandler,
};

export default plugin;
export { TwilioStageConfig };
