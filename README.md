# cicd

[![CI](https://img.shields.io/github/actions/workflow/status/abwaters/cicd/ci.yml?branch=main&label=CI)](https://github.com/abwaters/cicd/actions/workflows/ci.yml)
[![Version](https://img.shields.io/github/package-json/v/abwaters/cicd)](https://github.com/abwaters/cicd/blob/main/package.json)
[![License](https://img.shields.io/github/license/abwaters/cicd)](LICENSE)

Custom AWS CI/CD deployment tool for managing Lambda functions, API Gateway, and SNS resources.

New here? Start with the concept docs, then follow the [QUICKSTART](QUICKSTART.md) to get a deployment running:

- [Infrastructure Models](docs/infrastructure-models.md) — the API and WWW deployment models, the Lambda → Fargate scale-out path, and the opinions that shape them
- [Versioning: Semver vs Commit](docs/versioning.md) — why deployments are keyed by git commit while the tool itself is semver'd, and where each scheme belongs

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
cicd rollback prod
cicd info
cicd clean
```

### Local Usage (without global install)

If not installed globally, you can run commands using npm scripts or node directly:

```bash
npm run validate
node src/index.js deploy dev abc123
node src/index.js rollback prod
node src/index.js info
node src/index.js clean
```

## Configuration

The deployment system is driven by `cicd.json`, which defines your AWS infrastructure and deployment configuration. A reference file is provided at `cicd.example.json` — copy it to `cicd.json` and edit:

```bash
cp cicd.example.json cicd.json
```

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
  "repo": "owner/repo",               // Optional: GitHub repo for deployment tracking & rollback
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

### Rollback

Rollback a stage to a previous deployment. Requires `repo` in `cicd.json` (uses GitHub Deployments API for history).

```bash
# Rollback to the most recent prior successful deployment
cicd rollback <stage>

# Rollback to a specific commit
cicd rollback <stage> <commit>

# Partial rollback (same flags as deploy)
cicd rollback <stage> --env              # Only rollback environment variables
cicd rollback <stage> --api              # Only rollback API Gateway
cicd rollback <stage> --sns              # Only rollback SNS topics
cicd rollback <stage> --api-filter=name  # Rollback specific API
cicd rollback <stage> --verbose          # Enable verbose logging
```

Examples:
```bash
cicd rollback prod
cicd rollback staging abc1234
cicd rollback prod --api
```

The command fetches recent successful deployments from GitHub, displays a confirmation prompt showing the current and target commits, and executes the rollback using the same deployment operations as `deploy`.

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

### Install

Install any plugins listed in `cicd.json`'s `plugins[]` array that aren't already in `node_modules`. Runs `npm install --save-dev` so the plugins are tracked in your `package.json` and lockfile.

```bash
cicd install

# Enable verbose logging
cicd install --verbose
```

If you're using a private registry (e.g. GitHub Packages), make sure your `.npmrc` is set up before running this — `cicd install` just shells out to `npm install` and will fail with the same auth error you'd see otherwise.

### Env

Output a stage's fully resolved environment variables (globals merged with the stage's overrides, `!ImportValue` / `!ParameterStore` / `!SetEnv` references resolved) in a shell-ready format:

```bash
cicd env dev                # Windows CMD format: set KEY=VALUE
cicd env dev --linux        # export KEY="VALUE"
cicd env dev --powershell   # $env:KEY = "VALUE"
```

### Restart

Force a new deployment of a Fargate service without changing its task definition (`computeMode: "fargate"` only):

```bash
cicd restart dev

# Don't wait for the service to stabilize
cicd restart dev --no-wait
```

### Invalidate

Create CloudFront invalidations for a stage's web exports without redeploying:

```bash
cicd invalidate dev                       # invalidates /*
cicd invalidate dev /index.html /app.js   # specific paths
cicd invalidate dev --web-filter=www      # limit to one web export
```

### CloudFront

Generate the CloudFormation Origin + CacheBehavior fragment for a CloudFront-mapped stage (`stages[].cloudfront`) — paste it into your template once:

```bash
cicd cloudfront dev                      # YAML fragment
cicd cloudfront dev --json               # JSON instead
cicd cloudfront dev --api-filter=MyApi   # limit to one API
```

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

This allows multiple versions to coexist and enables easy rollback via the `rollback` command or by redeploying a previous commit.

## Architecture

### Key Files

- **src/index.ts**: Main CLI entry point with command routing
- **src/deploy.ts**: Deployment command implementation
- **src/rollback.ts**: Rollback command (uses GitHub deployment history)
- **src/info.ts**: Info command to show current deployments
- **src/clean.ts**: Clean command to remove unused resources
- **src/validate.ts**: Configuration validation command
- **src/types.ts**: TypeScript interfaces for config, results, and CLI options
- **src/shared/cicd.ts**: Core orchestration logic
- **src/shared/lambda.ts**: Lambda API wrapper
- **src/shared/apigw.ts**: API Gateway wrapper
- **src/shared/sns.ts**: SNS wrapper
- **src/shared/cloudformation.ts**: CloudFormation wrapper
- **src/shared/ps.ts**: Parameter Store wrapper
- **src/shared/config.ts**: Configuration loader
- **src/shared/options.ts**: CLI option parser
- **src/shared/github.js**: GitHub Deployments API wrapper
- **src/shared/plugin.ts** / **plugins.ts** / **plugin-runner.ts**: Plugin system (loader, runner, types)
- **src/shared/credentials.ts**: AWS credential validation
- **src/shared/logger.ts**: Logging utility with verbose mode
- **src/shared/utils.ts**: Sleep/rate limiting utilities
- **src/shared/header.ts**: CLI header display

### Dependencies

- AWS SDK v3 clients for Lambda, API Gateway, SNS, CloudFormation, SSM, and STS
- AJV for JSON schema validation
- GitHub CLI (`gh`) for deployment tracking (optional, used by deploy/rollback)
- Twilio integration via the optional plugin package [`@abwaters/cicd-plugin-twilio`](https://github.com/abwaters/cicd-plugin-twilio) — install separately and list in `cicd.json` under `"plugins"`

## License

MIT — see [LICENSE](LICENSE).
