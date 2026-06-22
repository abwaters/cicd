// ─── Configuration (cicd.json shape) ─────────────────────────────────────────

export interface CICDConfig {
    app: string;
    account?: string;
    region?: string;
    repo?: string;
    computeMode?: 'lambda' | 'fargate' | 'batch';
    fargate?: FargateConfig;
    batch?: BatchConfig;
    environment?: Record<string, string>;
    environmentGroups?: Record<string, string[]>;
    throttle?: ThrottleSettings;
    exports: ExportConfig[];
    workers?: WorkerFunctionConfig[];
    stages: StageConfig[];
    plugins?: string[];
}

export interface FargateConfig {
    cluster: string;
    ecrRepository: string;
    containerName: string;
    httpApi?: string;
}

export interface BatchConfig {
    jobQueue: string;                       // job queue ARN or name; !ImportValue supported
    executionRole?: string;                 // default execution role for all jobs; !ImportValue supported
    jobs: BatchJobConfig[];
}

export interface BatchJobConfig {
    name: string;                           // logical job name (e.g. "reminders-morning")
    image: string;                          // ECR repository URI; !ImportValue supported. Tagged :{commit} at deploy.
    jobRole?: string;                       // IAM job role ARN; !ImportValue supported
    executionRole?: string;                 // overrides BatchConfig.executionRole for this job
    vcpu?: number;                          // default 1
    memory?: number;                        // MiB, default 1024
    command?: string[];                     // container command override
    logGroup?: string;                      // CloudWatch log group for awslogs driver
    environment?: Record<string, string>;   // job-specific env; merged over global+stage. Special prefixes supported.
}

export interface ThrottleSettings {
    rateLimit: number;
    burstLimit: number;
}

export interface WebCacheControl {
    html?: string;   // Cache-Control for .html (default: no-cache, no-store, must-revalidate)
    assets?: string; // Cache-Control for non-.html (default: public, max-age=31536000, immutable)
}

export interface ExportConfig {
    type: 'api' | 'sns' | 'sqs' | 'web';
    name: string;
    path?: string;
    prefix?: string;
    throttle?: ThrottleSettings;
    stages?: string[];
    functions?: FunctionConfig[];
    distribution?: string;          // web: CFN export name for CloudFront distribution ID
    source?: string;                // web: local source dir override (default ./dist)
    noindexStages?: string[];       // web: stages that get an injected Disallow:/ robots.txt
    cacheControl?: WebCacheControl; // web: override Cache-Control for html / non-html objects
    value?: string;                 // resolved at runtime (S3 bucket name for web)
    distributionValue?: string;     // web: resolved at runtime (CloudFront distribution ID)
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
    mapping?: StageMapping;
    cloudfront?: StageCloudFront;
    environment?: Record<string, string>;
    throttle?: ThrottleSettings;
    service?: string;
    taskFamily?: string;
    httpApi?: string;
    cpu?: string;
    memory?: string;
    production?: boolean;
}

export interface StageMapping {
    domain: string;
    path: string;
}

// Serves a stage's API Gateway REST APIs through an existing CloudFront
// distribution at a path prefix (e.g. /api), instead of (or alongside) a custom
// domain. The distribution's API origin and cache behavior are owned by
// CloudFormation; cicd only validates (drift-check) and invalidates.
export interface StageCloudFront {
    distribution: string;        // CFN export name → CloudFront distribution ID
    path?: string;               // path-prefix segment (default 'api' → /api/*)
    invalidate?: boolean;        // invalidate the mapped path after deploy (default true)
    cachePolicy?: string;        // expected cache policy id/name (drift validation only)
    distributionValue?: string;  // resolved at runtime (CloudFront distribution ID)
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
    web?: boolean;
    apiFilter?: string;
    webFilter?: string;
    job?: string;
    dryRun?: boolean;
    details?: boolean;
    force?: boolean;
    keep?: string;
    transient?: boolean;
    noTransient?: boolean;
    description?: string;
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
    description?: string;
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
    mapping: 'created' | 'existing' | 'moved' | 'skipped';
    cloudfront?: 'ok' | 'drift' | 'missing';
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
    action: 'created' | 'updated' | 'exists' | 'skipped';
    version: string;
    commit?: string;
}

export interface WorkerResult {
    functions: WorkerFunctionResult[];
}

export interface WebExportResult {
    name: string;
    bucket: string;
    distribution: string;
    liveCommit: string;   // commit now serving at {stage}/live
    livePath: string;     // '/{stage}/live' (static origin path), for display
    invalidationId?: string;
    fileCount: number;
    totalBytes: number;
    noindexInjected: boolean;
    restored?: boolean;   // rollback: live/ repointed to an existing artifact (no upload)
}

export interface WebResult {
    exports: WebExportResult[];
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

export interface BranchStatus {
    onMain: boolean;
    isMainTip: boolean;
    behindBy: number;
    aheadBy: number;
    status: 'identical' | 'behind' | 'ahead' | 'diverged' | 'unknown';
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

// ─── Batch Deploy Result Types ───────────────────────────────────────────────

export interface BatchJobDeployResult {
    job: string;                            // logical job name
    jobDefinitionName: string;              // registered job definition name ({app}-{stage}-{job})
    jobDefinitionArn: string;               // ARN of the new revision
    revision: number;
    image: string;                          // {repoUri}:{commit}
}

export interface BatchDeployResult {
    jobs: BatchJobDeployResult[];
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
    aliasesRemoved: number;
    versionsRemoved: number;
    activeAliases: string[];
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

// ─── Plugin Types (re-exports for plugin authors) ────────────────────────────

export type {
    CICDPlugin,
    PluginContext,
    PluginInfoContext,
    PluginResult,
    PluginPhase,
} from './shared/plugin';
