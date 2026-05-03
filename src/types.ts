// ─── Configuration (cicd.json shape) ─────────────────────────────────────────

export interface CICDConfig {
    app: string;
    account: string;
    region: string;
    repo?: string;
    computeMode?: 'lambda' | 'fargate';
    fargate?: FargateConfig;
    environment?: Record<string, string>;
    environmentGroups?: Record<string, string[]>;
    throttle?: ThrottleSettings;
    exports: ExportConfig[];
    workers?: WorkerFunctionConfig[];
    stages: StageConfig[];
}

export interface FargateConfig {
    cluster: string;
    ecrRepository: string;
    containerName: string;
    httpApi?: string;
}

export interface ThrottleSettings {
    rateLimit: number;
    burstLimit: number;
}

export interface ExportConfig {
    type: 'api' | 'sns' | 'sqs';
    name: string;
    path?: string;
    prefix?: string;
    throttle?: ThrottleSettings;
    stages?: string[];
    functions: FunctionConfig[];
    value?: string; // resolved at runtime
}

export interface FunctionConfig {
    name: string;
    method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS';
    env?: string;
    concurrency?: number;
    batchSize?: number;
    maximumBatchingWindowInSeconds?: number;
    maximumConcurrency?: number;
    value?: string; // resolved at runtime
}

export interface SNSFunctionConfig {
    name: string;
    env?: string;
    concurrency?: number;
    value?: string; // resolved at runtime
}

export interface SQSFunctionConfig {
    name: string;
    env?: string;
    concurrency?: number;
    batchSize?: number;
    maximumBatchingWindowInSeconds?: number;
    maximumConcurrency?: number;
    value?: string; // resolved at runtime
}

export interface WorkerFunctionConfig {
    name: string;
    env?: string;
    concurrency?: number;
    stages?: string[];
    value?: string; // resolved at runtime
}

export interface StageConfig {
    stage: string;
    mapping: StageMapping;
    environment?: Record<string, string>;
    throttle?: ThrottleSettings;
    twilio?: TwilioStageConfig;
    service?: string;
    taskFamily?: string;
    httpApi?: string;
    cpu?: string;
    memory?: string;
}

export interface StageMapping {
    domain: string;
    path: string;
}

export interface TwilioStageConfig {
    messagingSid: string;
    smsWebhookApi: string;
}

// ─── CLI Options ─────────────────────────────────────────────────────────────

export interface CLIOptions {
    verbose?: boolean;
    noHeader?: boolean;
    env?: boolean;
    api?: boolean;
    sns?: boolean;
    sqs?: boolean;
    workers?: boolean;
    apiFilter?: string;
    noTwilio?: boolean;
    dryRun?: boolean;
    details?: boolean;
    [key: string]: string | boolean | undefined;
}

// ─── AWS Wrapper Return Types ────────────────────────────────────────────────

// Lambda

export interface VersionInfo {
    version: string;
    description: string;
    arn: string;
}

export interface VersionListItem {
    version: string;
    description: string;
}

export interface AliasInfo {
    alias: string;
    version: string;
}

// API Gateway

export interface DeploymentInfo {
    id: string;
    description?: string;
    createdDate?: string;
}

export interface StageInfo {
    stageName: string;
    deploymentId: string;
    description?: string;
    variables: Record<string, string>;
    tags?: Record<string, string>;
}

export interface BasePathMappingInfo {
    basePath: string;
    restApiId: string;
    stage: string;
}

export interface PatchOperation {
    op: 'replace' | 'add' | 'remove';
    path: string;
    value?: string;
}

// SNS

export interface SubscriptionInfo {
    subscriptionArn: string;
    protocol: string;
    endpoint: string;
}

// SQS / Lambda EventSourceMappings

export interface EventSourceMappingInfo {
    uuid: string;
    functionArn: string;
    eventSourceArn: string;
    state?: string;
    batchSize?: number;
    maximumBatchingWindowInSeconds?: number;
    maximumConcurrency?: number;
}

export interface EventSourceMappingOptions {
    batchSize?: number;
    maximumBatchingWindowInSeconds?: number;
    maximumConcurrency?: number;
}

// CloudFormation

export interface CFExport {
    Name: string;
    Value: string;
}

// ─── Deploy Result Types ─────────────────────────────────────────────────────

export interface EnvResult {
    name: string;
    updated: boolean;
    varCount: number;
}

export interface APIFunctionResult {
    name: string;
    action: 'created' | 'exists';
    version: string;
}

export interface APIDeploymentResult {
    name: string;
    deployment: 'created' | 'existing';
    stage: 'created' | 'updated';
    mapping: 'created' | 'existing';
    throttle: string;
    functions: number;
}

export interface APIResult {
    functions: APIFunctionResult[];
    apis: APIDeploymentResult[];
}

export interface SNSFunctionResult {
    name: string;
    action: 'created' | 'exists';
    version: string;
}

export interface SNSSubscriptionResult {
    name: string;
    action: 'subscribed' | 'skipped';
    oldRemoved?: number;
}

export interface SNSResult {
    functions: SNSFunctionResult[];
    subscriptions: SNSSubscriptionResult[];
}

export interface SQSFunctionResult {
    name: string;
    action: 'created' | 'exists';
    version: string;
}

export interface SQSEventSourceResult {
    name: string;
    action: 'created' | 'updated' | 'exists' | 'skipped';
    oldRemoved?: number;
}

export interface SQSResult {
    functions: SQSFunctionResult[];
    eventSources: SQSEventSourceResult[];
}

export interface WorkerFunctionResult {
    name: string;
    action: 'created' | 'exists' | 'skipped';
    version: string;
}

export interface WorkerResult {
    functions: WorkerFunctionResult[];
}

// ─── Twilio Types ────────────────────────────────────────────────────────────

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

export interface TwilioDeployResult {
    messagingSid: string;
    friendlyName?: string;
    phoneNumber?: string;
    webhookUrl: string;
    action: 'updated';
}

// ─── GitHub Types ────────────────────────────────────────────────────────────

export interface GitHubDeployment {
    id: number;
    ref: string;
    environment: string;
    description: string;
    status: string;
    statusDescription: string;
    createdAt: string;
}

// ─── Info Command Types ──────────────────────────────────────────────────────

export interface InfoApiDetail {
    name: string;
    stage: string;
    commit: string;
    functions: InfoFunctionDetail[];
}

export interface InfoFunctionDetail {
    name: string;
    commit: string;
}

export interface InfoStageEntry {
    name: string;
    commits: Record<string, number>;
    details: InfoApiDetail[];
    functions: InfoFunctionDetail[];
}

export interface InfoTopicResult {
    name: string;
    commit: string | null;
}

export interface InfoQueueResult {
    name: string;
    commit: string | null;
}

export interface InfoWorkerResult {
    name: string;
    commits: Record<string, string>; // stageOrLabel -> commit
}

export interface InfoTwilioResult {
    stage: string;
    label: string;
    webhookUrl: string;
    type: 'messaging-service' | 'phone-number';
}

export interface InfoGitHubResult {
    stage: string;
    deployments: GitHubDeployment[];
}

// ─── Fargate Deploy Result Types ─────────────────────────────────────────────

export interface FargateDeployResult {
    taskDefinitionArn: string;
    previousTaskDefinitionArn: string;
    image: string;
    serviceStable: boolean;
    deploymentFailed: boolean;
    failureReason?: string;
    stoppedTaskReasons?: string[];
    rolledBack: boolean;
}

export interface FargateRestartResult {
    cluster: string;
    service: string;
    taskDefinitionArn: string;
    serviceStable: boolean;
}

// ─── Clean Command Types ─────────────────────────────────────────────────────

export interface CleanApiResult {
    name: string;
    removed: number;
    activeCount: number;
    activeStageLabels: string[];
}

export interface CleanTopicResult {
    name: string;
    commit: string | null;
}

export interface CleanQueueResult {
    name: string;
    commit: string | null;
}

export interface CleanWorkerResult {
    name: string;
    activeCount: number;
}

export interface CleanFunctionResult {
    name: string;
    aliasesRemoved: number;
    versionsRemoved: number;
    activeCount: number;
}

export interface CleanEcrResult {
    repositoryName: string;
    deleted: number;
    failures: number;
    activeCount: number;
}
