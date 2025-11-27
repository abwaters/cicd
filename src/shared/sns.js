const { SNSClient, SubscribeCommand, ListSubscriptionsByTopicCommand, UnsubscribeCommand } = require("@aws-sdk/client-sns");

const client = new SNSClient({ region: "us-east-1" });

async function subscribeLambdaToTopic(topicArn,lambdaArn) {
    try {
        const params = {
            Protocol: "lambda",
            TopicArn: topicArn,
            Endpoint: lambdaArn
        };

        const subscription = await client.send(new SubscribeCommand(params));
    } catch (error) {
        console.error("Error subscribing Lambda to SNS:", error);
    }
}

async function listSubscriptionsByTopic(topicArn) {
    try {
        let command = new ListSubscriptionsByTopicCommand({
            TopicArn: topicArn
        });
        let subscriptions = [];
        let response = await client.send(command);
        for(const r of response.Subscriptions ) {
            subscriptions.push({subscriptionArn: r.SubscriptionArn, protocol: r.Protocol, endpoint: r.Endpoint});
        }
        while (response.NextToken) {
            command.input.NextToken = response.NextToken;
            response = await client.send(command);
            for(const r of response.Subscriptions ) {
                subscriptions.push(r.Endpoint);
            }
        }
        return subscriptions;
    } catch (error) {
        console.error("Error listing subscriptions for topic:", error);
    }
}

async function deleteSubscription(subscriptionArn) {
    try {
        const command = new UnsubscribeCommand({
            SubscriptionArn: subscriptionArn,
        });
        await client.send(command);
    } catch (error) {
        console.error("Error deleting subscription:", error);
    }
}

module.exports = {subscribeLambdaToTopic,listSubscriptionsByTopic, deleteSubscription };