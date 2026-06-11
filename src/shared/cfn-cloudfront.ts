// Generates the CloudFormation a stage's CloudFront distribution needs so that
// its API Gateway REST APIs are served at a path prefix (e.g. /api/*). cicd
// never mutates the distribution itself — the origin and cache behavior are
// owned by CloudFormation — so this builder produces a ready-to-paste fragment
// that the user adds to their template once, before the first deploy.
//
// The origin DomainName is emitted as the concrete resolved endpoint
// ({apiId}.execute-api.{region}.amazonaws.com), which is always valid regardless
// of stack topology. Commented alternatives show the same-stack !Ref form and the
// cross-stack Fn::ImportValue form, so the user can pick whichever fits their
// layout (Fn::ImportValue of an export defined in the same stack is circular).

export interface CfnApi {
    name: string;        // API export name — used as the CloudFront origin Id
    apiId: string;       // resolved API Gateway REST API ID
    region: string;      // AWS region of the API
    pathPattern: string; // ordered cache behavior path pattern (e.g. /api/orders/*)
    exportName: string;  // CFN export name the API ID is resolved from
}

export interface CfnFragmentOptions {
    stage: string;
    apis: CfnApi[];
    cachePolicy?: string;
    format?: 'yaml' | 'json';
}

const DEFAULT_CACHE_POLICY = '<cache-policy-id>';

function originDomain(api: CfnApi): string {
    return `${api.apiId}.execute-api.${api.region}.amazonaws.com`;
}

function buildYaml(opts: CfnFragmentOptions): string {
    const cachePolicy = opts.cachePolicy ?? DEFAULT_CACHE_POLICY;
    const lines: string[] = [];
    lines.push(`# ── cicd: CloudFront wiring for stage '${opts.stage}' ──`);
    lines.push(`# Merge these into Resources.<YourDistribution>.Properties.DistributionConfig.`);
    lines.push(`# DomainName uses the concrete API Gateway endpoint (always valid). Alternatives:`);
    lines.push(`#   • same stack as the API:   !Sub '\${<ApiLogicalId>}.execute-api.\${AWS::Region}.amazonaws.com'`);
    lines.push(`#   • cross-stack (API export): !Sub ['\${ApiId}.execute-api.\${AWS::Region}.amazonaws.com', { ApiId: !ImportValue <export> }]`);
    lines.push(`# Set CachePolicyId to TTLs appropriate to the REST API.`);
    lines.push(`Origins:`);
    for (const api of opts.apis) {
        lines.push(`  - Id: ${api.name}`);
        lines.push(`    DomainName: ${originDomain(api)}   # cross-stack export: ${api.exportName}`);
        lines.push(`    OriginPath: /${opts.stage}`);
        lines.push(`    CustomOriginConfig:`);
        lines.push(`      OriginProtocolPolicy: https-only`);
        lines.push(`      OriginSSLProtocols: [TLSv1.2]`);
    }
    lines.push(`CacheBehaviors:`);
    for (const api of opts.apis) {
        lines.push(`  - PathPattern: ${api.pathPattern}`);
        lines.push(`    TargetOriginId: ${api.name}`);
        lines.push(`    ViewerProtocolPolicy: redirect-to-https`);
        lines.push(`    CachePolicyId: ${cachePolicy}`);
    }
    return lines.join('\n');
}

function buildJson(opts: CfnFragmentOptions): string {
    const cachePolicy = opts.cachePolicy ?? DEFAULT_CACHE_POLICY;
    const fragment = {
        Origins: opts.apis.map(api => ({
            Id: api.name,
            DomainName: originDomain(api),
            OriginPath: `/${opts.stage}`,
            CustomOriginConfig: {
                OriginProtocolPolicy: 'https-only',
                OriginSSLProtocols: ['TLSv1.2']
            }
        })),
        CacheBehaviors: opts.apis.map(api => ({
            PathPattern: api.pathPattern,
            TargetOriginId: api.name,
            ViewerProtocolPolicy: 'redirect-to-https',
            CachePolicyId: cachePolicy
        }))
    };
    return JSON.stringify(fragment, null, 2);
}

export function buildCloudFrontFragment(opts: CfnFragmentOptions): string {
    return (opts.format === 'json') ? buildJson(opts) : buildYaml(opts);
}
