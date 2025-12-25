const { SNSClient, SubscribeCommand, ListSubscriptionsByTopicCommand, UnsubscribeCommand } = require("@aws-sdk/client-sns");
const { getConfig } = require('./config');

let client = null;

async function getClient() {
    if (!client) {
        const region = await getConfig('region');
        client = new SNSClient({ region });
    }
    return client;
}

async function subscribeLambdaToTopic(topicArn,lambdaArn) {
    try {
        const params = {
            Protocol: "lambda",
            TopicArn: topicArn,
            Endpoint: lambdaArn
        };

        const snsClient = await getClient();
        const subscription = await snsClient.send(new SubscribeCommand(params));
    } catch (error) {
        console.error("Error subscribing Lambda to SNS:", error);
    }
}

/**
 * Lists all subscriptions for an SNS topic (with pagination support)
 * @param {string} topicArn - The SNS topic ARN
 * @returns {Promise<Array>} Array of subscription objects with {subscriptionArn, protocol, endpoint}, or empty array on error
 */
async function listSubscriptionsByTopic(topicArn) {
    try {
        let command = new ListSubscriptionsByTopicCommand({
            TopicArn: topicArn
        });
        let subscriptions = [];
        const snsClient = await getClient();
        let response = await snsClient.send(command);
        for(const r of (response.Subscriptions || [])) {
            subscriptions.push({subscriptionArn: r.SubscriptionArn, protocol: r.Protocol, endpoint: r.Endpoint});
        }
        while (response.NextToken) {
            command.input.NextToken = response.NextToken;
            response = await snsClient.send(command);
            for(const r of (response.Subscriptions || [])) {
                subscriptions.push({subscriptionArn: r.SubscriptionArn, protocol: r.Protocol, endpoint: r.Endpoint});
            }
        }
        return subscriptions;
    } catch (error) {
        console.error("Error listing subscriptions for topic:", error);
        return [];
    }
}

async function deleteSubscription(subscriptionArn) {
    try {
        const command = new UnsubscribeCommand({
            SubscriptionArn: subscriptionArn,
        });
        const snsClient = await getClient();
        await snsClient.send(command);
    } catch (error) {
        console.error("Error deleting subscription:", error);
    }
}

module.exports = {subscribeLambdaToTopic,listSubscriptionsByTopic, deleteSubscription };