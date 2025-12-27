# cicd

Custom AWS CI/CD deployment tool for managing Lambda functions, API Gateway, and SNS resources.

## Installation

### Local Development

```bash
npm install
```

### Global Installation

To install as a global CLI command:

```bash
npm install -g .
```

After global installation, you can use the `cicd` command from anywhere:

```bash
cicd validate
cicd deploy dev abc123
cicd info
cicd clean
```

### Local Usage (without global install)

If not installed globally, you can run commands using npm scripts or node directly:

```bash
npm run validate
node src/index.js deploy dev abc123
node src/index.js info
node src/index.js clean
```

## Configuration

The deployment system is driven by `cicd.json`, which defines your AWS infrastructure and deployment configuration.

### Configuration Validation

Before deploying, validate your `cicd.json` configuration:

```bash
cicd validate
# or: npm run validate
```

The validation checks:
- Required fields are present (app, account, region, exports, stages)
- AWS account ID is a valid 12-digit number
- AWS region follows the correct format
- Export types are valid (api or sns)
- API configurations have required path and functions
- Function configurations have valid HTTP methods
- Environment variable names follow naming conventions
- Stage configurations are properly structured

### Schema Reference

The `cicd.schema.json` file defines the complete structure. Key elements:

#### Root Configuration

```json
{
  "app": "string",                     // Application name
  "account": "123456789012",           // AWS account ID (12 digits)
  "region": "us-east-1",               // AWS region
  "environment": {},                   // Global environment variables
  "exports": [],                       // API and SNS resource configurations
  "stages": []                         // Deployment stages
}
```

#### Environment Variables

Environment variables support special resolution syntax:

```json
{
  "environment": {
    "VAR_FROM_CF": "!ImportValue stack-export-name",
    "VAR_FROM_SSM": "!ParameterStore /path/to/param",
    "VAR_FROM_ENV": "!SetEnv LOCAL_ENV_VAR"
  }
}
```

#### API Export

```json
{
  "type": "api",
  "name": "cf-export-name",           // CloudFormation export name for API ID
  "path": "api-path",                 // Base path
  "throttle": {                       // Optional: global throttle settings for all methods
    "rateLimit": 10,                  // Requests per second
    "burstLimit": 20                  // Maximum concurrent requests
  },
  "functions": [
    {
      "name": "cf-export-name",       // CloudFormation export name for Lambda ARN
      "method": "GET",                // HTTP method
      "env": "VAR1,VAR2",             // Optional: environment variables to include
      "concurrency": 0                // Optional: reserved concurrent executions
    }
  ]
}
```

#### SNS Export

```json
{
  "type": "sns",
  "name": "cf-export-name",           // CloudFormation export name for SNS topic ARN
  "stages": ["prod"],                 // Optional: limit to specific stages
  "functions": [
    {
      "name": "cf-export-name",
      "method": "POST",
      "env": "VAR1,VAR2"
    }
  ]
}
```

#### Stage Configuration

```json
{
  "stage": "prod",
  "mapping": {
    "domain": "api.example.com",
    "path": ""                        // Base path (empty for root)
  },
  "environment": {
    "STAGE_VAR": "value"              // Stage-specific overrides
  },
  "throttle": {                       // Optional: stage-specific throttle overrides
    "rateLimit": 100,                 // Requests per second
    "burstLimit": 200                 // Maximum concurrent requests
  }
}
```

## Commands

All commands support the `--verbose` flag for detailed debugging output.

### Deploy

Deploy a commit to a stage:

```bash
cicd deploy <stage> <commit>

# Deploy with options
cicd deploy <stage> <commit> --env              # Only update environment variables
cicd deploy <stage> <commit> --api              # Only update API Gateway
cicd deploy <stage> <commit> --sns              # Only update SNS topics
cicd deploy <stage> <commit> --api-filter=name  # Deploy specific API
cicd deploy <stage> <commit> --verbose          # Enable verbose logging
```

Examples:
```bash
cicd deploy dev abc123
cicd deploy prod abc123 --api
cicd deploy staging abc123 --verbose
```

### Info

Show current deployments for all stages:

```bash
cicd info

# Include Lambda function versions
cicd info --details

# Enable verbose logging
cicd info --verbose
```

### Clean

Remove unused API deployments, Lambda aliases, and versions:

```bash
cicd clean

# Enable verbose logging
cicd clean --verbose
```

This command:
- Identifies active commits from API stages and SNS subscriptions
- Deletes API Gateway deployments not used by any stage
- Removes Lambda aliases not associated with active commits
- Removes Lambda versions not referenced by active aliases

### Validate

Validate cicd.json configuration:

```bash
cicd validate

# Enable verbose logging
cicd validate --verbose
```

## How It Works

1. **Configuration Loading**: Reads `cicd.json` and validates against schema
2. **CloudFormation Resolution**: Resolves CloudFormation exports referenced in config
3. **Environment Resolution**: Resolves special environment variable syntax
4. **Lambda Versioning**: Creates Lambda versions and aliases based on Git commit
5. **API Deployment**: Updates API Gateway deployments and stages with throttling settings
6. **Domain Mapping**: Configures custom domain mappings for stages
7. **SNS Subscriptions**: Subscribes Lambda functions to SNS topics
8. **Permission Management**: Updates Lambda permissions for API Gateway and SNS triggers

### Throttling

API Gateway throttling can be configured at two levels:

- **Global (API-level)**: Apply default throttle settings to all methods in an API
- **Stage-specific**: Override global settings for specific deployment stages

Throttling settings use AWS API Gateway's method-level throttling (`/*/*/throttling/rateLimit` and `/*/*/throttling/burstLimit` paths), which apply globally to all resource paths and HTTP methods in a stage.

## Versioning

Lambda functions use Git commit-based versioning:
- Lambda version description: `<app>-<commit-hash>`
- Lambda alias name: `<app>-<commit-hash>`
- API Gateway stage variables: `Commit: <app>-<commit-hash>`

This allows multiple versions to coexist and enables easy rollback by redeploying a previous commit.

## Architecture

### Key Files

- **src/index.js**: Main CLI entry point with command routing
- **src/deploy.js**: Deployment command implementation
- **src/info.js**: Info command to show current deployments
- **src/clean.js**: Clean command to remove unused resources
- **src/validate.js**: Configuration validation command
- **src/shared/cicd.js**: Core orchestration logic
- **src/shared/lambda.js**: Lambda API wrapper
- **src/shared/apigw.js**: API Gateway wrapper
- **src/shared/sns.js**: SNS wrapper
- **src/shared/cloudformation.js**: CloudFormation wrapper
- **src/shared/ps.js**: Parameter Store wrapper
- **src/shared/config.js**: Configuration loader
- **src/shared/options.js**: CLI option parser

### Dependencies

- AWS SDK v3 clients for Lambda, API Gateway, SNS, CloudFormation, SSM, and STS
- AJV for JSON schema validation

## License

ISC
