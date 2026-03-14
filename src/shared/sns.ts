import { SNSClient, SubscribeCommand, ListSubscriptionsByTopicCommand, UnsubscribeCommand } from "@aws-sdk/client-sns";
import { SubscriptionInfo } from '../types';

const { getConfig } = require('./config');
const { awsRetry } = require('./utils');

let client: SNSClient | null = null;

async function getClient(): Promise<SNSClient> {
    if (!client) {
        const region = await getConfig('region');
        client = new SNSClient({ region });
    }
    return client;
}

async function subscribeLambdaToTopic(topicArn: string, lambdaArn: string): Promise<void> {
    try {
        const params = {
            Protocol: "lambda" as const,
            TopicArn: topicArn,
            Endpoint: lambdaArn
        };

        const snsClient = await getClient();
        await awsRetry(() => snsClient.send(new SubscribeCommand(params)));
    } catch (error) {
        console.error("Error subscribing Lambda to SNS:", error);
    }
}

async function listSubscriptionsByTopic(topicArn: string): Promise<SubscriptionInfo[]> {
    try {
        let command = new ListSubscriptionsByTopicCommand({
            TopicArn: topicArn
        });
        let subscriptions: SubscriptionInfo[] = [];
        const snsClient = await getClient();
        let response = await awsRetry(() => snsClient.send(command));
        for(const r of (response.Subscriptions || [])) {
            subscriptions.push({subscriptionArn: r.SubscriptionArn!, protocol: r.Protocol!, endpoint: r.Endpoint!});
        }
        while (response.NextToken) {
            command = new ListSubscriptionsByTopicCommand({
                TopicArn: topicArn,
                NextToken: response.NextToken
            });
            response = await awsRetry(() => snsClient.send(command));
            for(const r of (response.Subscriptions || [])) {
                subscriptions.push({subscriptionArn: r.SubscriptionArn!, protocol: r.Protocol!, endpoint: r.Endpoint!});
            }
        }
        return subscriptions;
    } catch (error) {
        console.error("Error listing subscriptions for topic:", error);
        return [];
    }
}

async function deleteSubscription(subscriptionArn: string): Promise<void> {
    try {
        const command = new UnsubscribeCommand({
            SubscriptionArn: subscriptionArn,
        });
        const snsClient = await getClient();
        await awsRetry(() => snsClient.send(command));
    } catch (error) {
        console.error("Error deleting subscription:", error);
    }
}

module.exports = {subscribeLambdaToTopic, listSubscriptionsByTopic, deleteSubscription};
