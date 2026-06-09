import { buildCloudFrontFragment, CfnApi } from '../src/shared/cfn-cloudfront';

function api(overrides: Partial<CfnApi> = {}): CfnApi {
    return {
        name: 'myapp-orders-api',
        apiId: 'abc123',
        region: 'us-east-1',
        pathPattern: '/api/orders/*',
        exportName: 'myapp-orders-api',
        ...overrides,
    };
}

describe('buildCloudFrontFragment - yaml', () => {
    it('emits an Origin with the concrete endpoint and stage origin path', () => {
        const out = buildCloudFrontFragment({ stage: 'staging', apis: [api()] });
        expect(out).toContain('DomainName: abc123.execute-api.us-east-1.amazonaws.com');
        expect(out).toContain('OriginPath: /staging');
        expect(out).toContain('Id: myapp-orders-api');
    });

    it('emits a CacheBehavior with the path pattern and target origin', () => {
        const out = buildCloudFrontFragment({ stage: 'staging', apis: [api()] });
        expect(out).toContain('PathPattern: /api/orders/*');
        expect(out).toContain('TargetOriginId: myapp-orders-api');
        expect(out).toContain('ViewerProtocolPolicy: redirect-to-https');
    });

    it('uses the configured cache policy, else a placeholder', () => {
        expect(buildCloudFrontFragment({ stage: 's', apis: [api()] }))
            .toContain('CachePolicyId: <cache-policy-id>');
        expect(buildCloudFrontFragment({ stage: 's', apis: [api()], cachePolicy: 'pol-1' }))
            .toContain('CachePolicyId: pol-1');
    });

    it('documents the same-stack and cross-stack DomainName alternatives', () => {
        const out = buildCloudFrontFragment({ stage: 's', apis: [api()] });
        expect(out).toContain('same stack');
        expect(out).toContain('!ImportValue');
        expect(out).toContain('cross-stack export: myapp-orders-api');
    });

    it('emits one origin + behavior per API', () => {
        const out = buildCloudFrontFragment({
            stage: 'staging',
            apis: [
                api(),
                api({ name: 'myapp-customers-api', exportName: 'myapp-customers-api', pathPattern: '/api/customers/*' }),
            ],
        });
        expect(out).toContain('PathPattern: /api/orders/*');
        expect(out).toContain('PathPattern: /api/customers/*');
    });
});

describe('buildCloudFrontFragment - json', () => {
    it('emits valid parseable JSON with Origins and CacheBehaviors', () => {
        const out = buildCloudFrontFragment({ stage: 'staging', apis: [api()], format: 'json', cachePolicy: 'pol-1' });
        const parsed = JSON.parse(out);
        expect(parsed.Origins[0].DomainName).toBe('abc123.execute-api.us-east-1.amazonaws.com');
        expect(parsed.Origins[0].OriginPath).toBe('/staging');
        expect(parsed.CacheBehaviors[0].PathPattern).toBe('/api/orders/*');
        expect(parsed.CacheBehaviors[0].TargetOriginId).toBe('myapp-orders-api');
        expect(parsed.CacheBehaviors[0].CachePolicyId).toBe('pol-1');
    });
});
