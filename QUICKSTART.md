# Quickstart Guide

This tutorial walks you through setting up and using the cicd tool from scratch. By the end, you'll have a working deployment pipeline for Lambda functions with API Gateway and SNS integrations.

For complete reference documentation, see the [README](README.md).

## Prerequisites

- **Node.js** (v18+)
- **AWS CLI** configured with credentials (`aws configure`)
- **GitHub CLI** (`gh`) — required only for rollback functionality
- **AWS infrastructure already deployed** via CloudFormation:
  - Lambda functions
  - API Gateway REST APIs
  - SNS topics (if needed)
  - CloudFormation exports for each resource (the tool resolves resources by export name)

## 1. Install the Tool

```bash
npm install
npm install -g .
```

Verify the installation:

```bash
cicd validate
```

You'll see a validation error since there's no `cicd.json` yet — that's expected.

## 2. Create Your First `cicd.json`

Start with the skeleton. Every config needs an app name, AWS account, region, and at least one export and stage:

```json
{
  "app": "myapp",
  "account": "123456789012",
  "region": "us-east-1",
  "exports": [],
  "stages": []
}
```

### Add Environment Variables

Environment variables are resolved at deploy time using three special prefixes:

```json
{
  "app": "myapp",
  "account": "123456789012",
  "region": "us-east-1",
  "environment": {
    "DB_HOST": "!ImportValue myapp-db-host",
    "API_SECRET": "!ParameterStore /myapp/api-secret",
    "LOG_LEVEL": "!SetEnv LOG_LEVEL"
  },
  "exports": [],
  "stages": []
}
```

| Prefix | Resolves from | Example |
|--------|--------------|---------|
| `!ImportValue` | CloudFormation stack exports | `!ImportValue myapp-db-host` |
| `!ParameterStore` | AWS Systems Manager Parameter Store | `!ParameterStore /myapp/api-secret` |
| `!SetEnv` | Local process environment | `!SetEnv LOG_LEVEL` |

### Add an API Export

Each API export references a CloudFormation export name that resolves to an API Gateway REST API ID. Functions reference CloudFormation exports that resolve to Lambda ARNs:

```json
{
  "app": "myapp",
  "account": "123456789012",
  "region": "us-east-1",
  "environment": {
    "DB_HOST": "!ImportValue myapp-db-host",
    "API_SECRET": "!ParameterStore /myapp/api-secret",
    "LOG_LEVEL": "!SetEnv LOG_LEVEL"
  },
  "exports": [
    {
      "type": "api",
      "name": "myapp-api-id",
      "path": "myapp",
      "functions": [
        {
          "name": "myapp-get-items-arn",
          "method": "GET",
          "env": "DB_HOST,LOG_LEVEL"
        },
        {
          "name": "myapp-create-item-arn",
          "method": "POST",
          "env": "DB_HOST,API_SECRET,LOG_LEVEL"
        }
      ]
    }
  ],
  "stages": []
}
```

The `env` field is a comma-separated list of environment variable keys from the `environment` section. Only the listed variables are set on that function.

### Add a Stage

Stages map to API Gateway stages and custom domain paths:

```json
{
  "app": "myapp",
  "account": "123456789012",
  "region": "us-east-1",
  "environment": {
    "DB_HOST": "!ImportValue myapp-db-host",
    "API_SECRET": "!ParameterStore /myapp/api-secret",
    "LOG_LEVEL": "!SetEnv LOG_LEVEL"
  },
  "exports": [
    {
      "type": "api",
      "name": "myapp-api-id",
      "path": "myapp",
      "functions": [
        {
          "name": "myapp-get-items-arn",
          "method": "GET",
          "env": "DB_HOST,LOG_LEVEL"
        },
        {
          "name": "myapp-create-item-arn",
          "method": "POST",
          "env": "DB_HOST,API_SECRET,LOG_LEVEL"
        }
      ]
    }
  ],
  "stages": [
    {
      "stage": "dev",
      "mapping": {
        "domain": "api.example.com",
        "path": "myapp"
      }
    }
  ]
}
```

### Validate

```bash
cicd validate
```

If everything is correct, you'll see a success message. Fix any errors before proceeding.

## 3. Deploy

Deploy a Git commit to a stage:

```bash
cicd deploy dev abc1234
```

Here's what happens under the hood:

1. CloudFormation exports are resolved to get API and Lambda resource IDs
2. Environment variables are resolved (`!ImportValue`, `!ParameterStore`, `!SetEnv`)
3. Lambda function environment variables are updated
4. New Lambda versions are published (description: `myapp-abc1234`)
5. Lambda aliases are created (name: `myapp-abc1234`)
6. API Gateway deployment is created and the `dev` stage is updated
7. Stage variable `Commit` is set to `myapp-abc1234`
8. Custom domain base path mapping is configured

### Selective Deploys

You don't have to deploy everything. Use flags to target specific resources:

```bash
# Only update environment variables on Lambda functions
cicd deploy dev abc1234 --env

# Only update API Gateway (versions, aliases, deployments, stages)
cicd deploy dev abc1234 --api

# Only update SNS subscriptions
cicd deploy dev abc1234 --sns

# Deploy a specific API by name (when you have multiple APIs)
cicd deploy dev abc1234 --api-filter=myapp-api-id
```

### Verbose Output

Add `--verbose` to any command for detailed logging:

```bash
cicd deploy dev abc1234 --verbose
```

## 4. Check Deployment Status

```bash
# Show current commit deployed to each stage
cicd info

# Include Lambda function version details
cicd info --details
```

## 5. Add More Resources

### A Second API

Add another entry to the `exports` array:

```json
{
  "type": "api",
  "name": "myapp-admin-api-id",
  "path": "admin",
  "functions": [
    {
      "name": "myapp-admin-users-arn",
      "method": "GET",
      "env": "DB_HOST"
    }
  ]
}
```

### An SNS Topic

SNS exports subscribe Lambda functions to topics. Use the `stages` array to limit which stages get the subscription:

```json
{
  "type": "sns",
  "name": "myapp-order-topic-arn",
  "stages": ["prod"],
  "functions": [
    {
      "name": "myapp-process-order-arn",
      "method": "POST",
      "env": "DB_HOST,API_SECRET"
    }
  ]
}
```

This subscribes `myapp-process-order-arn` to the SNS topic only when deploying to the `prod` stage.

### Stage-Specific Environment Overrides

Override global environment variables for specific stages:

```json
{
  "stage": "prod",
  "mapping": {
    "domain": "api.example.com",
    "path": "myapp"
  },
  "environment": {
    "LOG_LEVEL": "!SetEnv PROD_LOG_LEVEL",
    "CACHE_TTL": "!ParameterStore /myapp/prod/cache-ttl"
  }
}
```

Stage-specific variables override globals — if both define `LOG_LEVEL`, the stage value wins.

### Throttling

Throttling controls API Gateway rate and burst limits. It can be set at three levels, with higher specificity taking priority:

**Global default** (applies to all APIs in all stages):

```json
{
  "app": "myapp",
  "throttle": {
    "rateLimit": 100,
    "burstLimit": 200
  }
}
```

**Stage-level** (overrides global for a specific stage):

```json
{
  "stage": "dev",
  "throttle": {
    "rateLimit": 10,
    "burstLimit": 20
  }
}
```

**API-level** (overrides stage-level for a specific API):

```json
{
  "type": "api",
  "name": "myapp-api-id",
  "path": "myapp",
  "throttle": {
    "rateLimit": 50,
    "burstLimit": 100
  },
  "functions": []
}
```

Priority: **API export > Stage > Global**.

## 6. Rollback

Rollback requires a `repo` field in your config so the tool can query GitHub deployment history:

```json
{
  "app": "myapp",
  "repo": "myorg/myapp"
}
```

Then rollback a stage:

```bash
# Rollback to the most recent prior successful deployment
cicd rollback prod

# Rollback to a specific commit
cicd rollback prod abc1234

# Partial rollback (same flags as deploy)
cicd rollback prod --api
```

The tool shows the current and target commits and prompts for confirmation before proceeding.

## 7. Clean Up

Over time, old Lambda versions, aliases, and API Gateway deployments accumulate. Remove unused ones:

```bash
cicd clean
```

This identifies active commits from all stages and SNS subscriptions, then deletes:
- API Gateway deployments not used by any stage
- Lambda aliases not tied to active commits
- Lambda versions not referenced by active aliases

## 8. Tips and Patterns

**Environment variable resolution order**: Global variables are loaded first, then stage-specific variables override them. Within each level, `!ImportValue` and `!ParameterStore` are resolved at deploy time against live AWS state.

**Concurrency throttling**: Set `"concurrency": 0` on a function to throttle it completely (useful for Slack webhook handlers that need rate limiting):

```json
{
  "name": "myapp-slack-handler-arn",
  "method": "POST",
  "env": "API_SECRET",
  "concurrency": 0
}
```

**Idempotent deploys**: Running the same deploy twice is safe. The tool checks for existing versions, aliases, and deployments before creating new ones.

**All operations are Git-commit-based**: Lambda versions, aliases, and API Gateway stage variables all reference the commit hash. This makes it easy to trace exactly what code is running in each stage.
