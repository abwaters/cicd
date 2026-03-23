# Plan: CICD Tool Support for Fargate Compute Mode

## Context

The nbrn-api and nbrn-infrastructure repos now support dual-mode deployment (Lambda + Fargate). The infrastructure is deployed:
- ECS Cluster: `nbrn-compute-cluster`
- ECR Repository: `907688428238.dkr.ecr.us-east-1.amazonaws.com/nbrn-api`
- HTTP API: `priikx67sj` (endpoint: `https://priikx67sj.execute-api.us-east-1.amazonaws.com`)
- Cloud Map Namespace: `nbrn-compute.local`
- ECS Service: `nbrn-api-service` (currently running with desired count 1)

The CICD tool needs to read the new `computeMode` field in `cicd.json` and handle deployments accordingly.

## cicd.json Contract

New field added to cicd.json:
```json
{
  "app": "nbrn",
  "computeMode": "lambda",
  ...
}
```

### Values

- **`"lambda"`** (default): Current behavior, no changes needed. CICD tool creates REST API deployments with commit-based stage variables, maps `api.neutralbrain.ai` base path to REST API stages.

- **`"fargate"`**: CICD tool routes traffic through the HTTP API backed by Fargate instead of REST API + Lambda.

## Implementation

### 1. Read `computeMode` from cicd.json

When the CICD tool loads `cicd.json`, read the `computeMode` field. Default to `"lambda"` if not present (backwards compatible).

### 2. Lambda Mode (no changes to existing behavior)

When `computeMode === "lambda"`:
- Deploy Lambda functions as today (create versions, aliases with commit hash)
- Create REST API deployments with `Commit` stage variable
- Map `api.neutralbrain.ai` base path to REST API stages
- Optionally: set ECS service desired count to 0 to save costs
  ```
  aws ecs update-service --cluster nbrn-compute-cluster --service nbrn-api-service --desired-count 0 --region us-east-1
  ```

### 3. Fargate Mode (new behavior)

When `computeMode === "fargate"`:

#### 3a. Build and push container image
```bash
# Build the server bundle
cd nbrn-api
npm run build:server

# Build and push Docker image (must be linux/amd64)
aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin 907688428238.dkr.ecr.us-east-1.amazonaws.com
docker buildx build --platform linux/amd64 \
  -t 907688428238.dkr.ecr.us-east-1.amazonaws.com/nbrn-api:${COMMIT} \
  -t 907688428238.dkr.ecr.us-east-1.amazonaws.com/nbrn-api:latest \
  --push .
```

#### 3b. Update ECS task definition with new image
```bash
# Register new task definition with commit-tagged image
# Update the ContainerImage in the task definition to use the commit tag
aws ecs register-task-definition \
  --family nbrn-api \
  --container-definitions '[{
    "name": "api",
    "image": "907688428238.dkr.ecr.us-east-1.amazonaws.com/nbrn-api:'${COMMIT}'",
    ...existing container config...
  }]' \
  --cpu 256 --memory 512 \
  --network-mode awsvpc \
  --requires-compatibilities FARGATE \
  --execution-role-arn <from CloudFormation export: nbrn-compute-taskexecutionrolearn> \
  --task-role-arn <from CloudFormation export: nbrn-compute-taskrolearn>
```

Or more simply, update the service to force a new deployment (if using `latest` tag):
```bash
aws ecs update-service \
  --cluster nbrn-compute-cluster \
  --service nbrn-api-service \
  --desired-count 1 \
  --force-new-deployment \
  --region us-east-1
```

#### 3c. Update API Gateway domain mapping

Switch `api.neutralbrain.ai` from REST API to HTTP API:

```bash
# Get the existing REST API base path mapping
aws apigateway get-base-path-mappings --domain-name api.neutralbrain.ai --region us-east-1

# Delete the REST API mapping for the stage being switched
aws apigateway delete-base-path-mapping \
  --domain-name api.neutralbrain.ai \
  --base-path "(none)" \
  --region us-east-1

# Create HTTP API domain name (one-time setup)
aws apigatewayv2 create-domain-name \
  --domain-name api.neutralbrain.ai \
  --domain-name-configurations CertificateArn=<nbrn-infrastructure-certificatearn> \
  --region us-east-1

# Create API mapping for HTTP API
aws apigatewayv2 create-api-mapping \
  --domain-name api.neutralbrain.ai \
  --api-id priikx67sj \
  --stage '$default' \
  --region us-east-1

# Update Route 53 to point to the HTTP API domain
# (may need to update the alias target to the HTTP API's regional domain name)
```

**Note**: The Route 53 record for `api.neutralbrain.ai` currently points to the REST API domain. When switching to HTTP API, the DNS alias target needs to change. This is the trickiest part — both REST API and HTTP API use different regional domain names.

#### 3d. Wait for service stability
```bash
aws ecs wait services-stable \
  --cluster nbrn-compute-cluster \
  --services nbrn-api-service \
  --region us-east-1
```

### 4. Switching Back to Lambda

When switching from `"fargate"` back to `"lambda"`:
1. Restore REST API base path mapping on `api.neutralbrain.ai`
2. Delete HTTP API domain mapping
3. Update Route 53 alias back to REST API regional domain
4. Set ECS desired count to 0

### 5. Environment Variables

In Fargate mode, environment variables are baked into the task definition (set by CloudFormation). The CICD tool does NOT need to manage them — they're imported directly from CloudFormation exports. The relevant env vars are:
- `DDB_TABLE` → `nbrn-ddb-brainstablename`
- `DDB_WAITLIST_TABLE` → `nbrn-ddb-waitlisttablename`
- `DDB_STORAGE_TABLE` → `nbrn-ddb-storagetablename`
- `RDS_SUBNET_GROUP` → `nbrn-storage-subnetgroupname`
- `RDS_SECURITY_GROUP_IDS` → `nbrn-storage-securitygroupid`
- `COGNITO_USER_POOL_ID` → `nbrn-identity-userpoolid`
- `COGNITO_CLIENT_ID` → `nbrn-identity-userpoolclientid`
- `COMMIT` → set by CICD during task definition registration

The one env var the CICD tool should set per-deployment: `COMMIT` (the git commit hash).

## CloudFormation Exports Available

| Export Name | Description |
|-------------|-------------|
| `nbrn-compute-clusterarn` | ECS cluster ARN |
| `nbrn-compute-ecrrepositoryuri` | ECR repository URI |
| `nbrn-compute-securitygroupid` | Compute security group ID |
| `nbrn-compute-httpapiendpoint` | HTTP API invoke URL |
| `nbrn-compute-httpapiid` | HTTP API ID |
| `nbrn-infrastructure-certificatearn` | ACM certificate for api.neutralbrain.ai |
| `nbrn-infrastructure-apidomainname` | Current REST API custom domain |

## Key Considerations

1. **Architecture**: Container images MUST be `linux/amd64` — Fargate does not support ARM in all regions and the task definition is configured for x86.

2. **Domain switching is the hardest part**: REST API and HTTP API use different domain name resources (`AWS::ApiGateway::DomainName` vs `AWS::ApiGatewayV2::DomainName`). The CICD tool needs to manage the transition carefully to avoid downtime.

3. **Rollback**: Keep the REST API Lambda functions deployed even in Fargate mode. To roll back, just switch the domain mapping back — Lambda functions are still there with their commit-based aliases.

4. **NBRN_TEST_SECRET**: This env var is loaded from Parameter Store in Lambda mode. For Fargate, it should be added to the task definition environment (or loaded at runtime from Parameter Store/Secrets Manager).

5. **Health check**: The Fargate container exposes `GET /health` on port 8080 — use this to verify the deployment before switching traffic.
