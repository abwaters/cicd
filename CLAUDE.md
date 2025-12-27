# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

This is a custom AWS CI/CD deployment tool for managing Lambda functions, API Gateway, and SNS resources. It reads configuration from `cicd.json` and orchestrates deployments across multiple stages using Git commit-based versioning.

## Core Commands

All commands are accessed through the main CLI tool at `src/index.js`:

```bash
# Validate configuration before deploying
npm run validate
# or: node src/index.js validate

# Deploy a commit to a stage
node src/index.js deploy <stage> <commit>

# Deploy with selective updates
node src/index.js deploy <stage> <commit> --env          # Only update environment variables
node src/index.js deploy <stage> <commit> --api          # Only update API Gateway
node src/index.js deploy <stage> <commit> --sns          # Only update SNS topics
node src/index.js deploy <stage> <commit> --api-filter=<api-name>  # Deploy specific API

# Get deployment information
node src/index.js info              # Show current deployments for all stages
node src/index.js info --details    # Include function versions

# Clean up old deployments
node src/index.js clean             # Remove unused API deployments, Lambda aliases/versions
```

## Architecture

### Configuration System (`cicd.json`)

The entire deployment system is driven by `cicd.json`, validated against `cicd.schema.json`. Configuration defines:
- AWS account and region
- Global and stage-specific environment variables
- API Gateway REST APIs with Lambda integrations
- SNS topics with Lambda subscribers
- Stage configurations with custom domain mappings

### Special Environment Variable Resolution

Environment variables support three resolution patterns:
- `!ImportValue <export-name>` - Resolves CloudFormation stack exports
- `!ParameterStore <param-path>` - Resolves AWS Systems Manager parameters
- `!SetEnv <env-var>` - Resolves from process environment variables

Resolution happens in `cicd.js:resolveEnvironmentVariable()`, with stage-specific overrides applied after global variables.

### Deployment Orchestration (`src/shared/cicd.js`)

The core orchestration module follows this flow:

1. **Initialization** (`init()`)
   - Loads CloudFormation exports via `initExports()`
   - Resolves all environment variables via `initEnvironment()`
   - Caches exports in `exportMap` and functions in `functionMap`
   - Stage config loaded via `setStageConfig()`

2. **Environment Variables** (`processFunctionEnvironmentVars()`)
   - Iterates all Lambda functions (API + SNS)
   - Builds environment object from config using `getVars()`
   - Updates each function configuration via `lambda.updateEnvironmentVariables()`

3. **API Gateway Deployment** (`processApiGateway()`)
   - **Functions**: Creates Lambda versions (with commit as description) and aliases (format: `{app}-{commit}`)
   - **APIs**: Creates/updates deployments, stages (with `Commit` variable), and custom domain mappings
   - **Throttling**: Applies global and stage-specific throttle settings using patch operations
   - **Permissions**: Adds Lambda permissions for API Gateway invocation

4. **SNS Deployment** (`processSNS()`)
   - **Functions**: Creates Lambda versions and aliases (same as API Gateway)
   - **Subscriptions**: Removes old subscriptions, adds new ones with aliased function ARN
   - **Permissions**: Adds Lambda permissions for SNS invocation
   - **Stage Filtering**: Honors `stages` array in SNS config to limit deployments

### Versioning Strategy

Git commit-based versioning ties everything together:
- **Lambda version description**: `{app}-{commit}`
- **Lambda alias name**: `{app}-{commit}`
- **API Gateway stage variables**: `Commit: {app}-{commit}`
- **API Gateway deployment description**: `{commit}`

The `info` command reconstructs deployment state by reading API stage variables and SNS subscription endpoints (which contain alias in ARN).

The `clean` command identifies active commits from stages/subscriptions, then deletes unused:
- API Gateway deployments
- Lambda aliases (not in active commits)
- Lambda versions (not referenced by active aliases)

### Key Data Structures

The `cicd.js` module maintains several caches:
- `rawExports`: Map of all CloudFormation exports (name → value)
- `exportMap`: Map of configured exports from `cicd.json` (name → config object with resolved value)
- `functionMap`: Map of all Lambda functions (name → config object with resolved ARN)
- `envCache`: Map of resolved environment variables (key → value)
- `stageConfig`: Current stage configuration object

### AWS SDK Wrappers

All AWS SDK calls go through wrapper modules in `src/shared/`:
- `lambda.js` - Versions, aliases, permissions, concurrency, environment variables
- `apigw.js` - Deployments, stages, custom domain mappings, base path mappings
- `sns.js` - Topic subscriptions, unsubscribe
- `cloudformation.js` - List exports
- `ps.js` - Get Parameter Store values
- `sts.js` - Get caller identity

Each wrapper uses AWS SDK v3 with modular imports (`@aws-sdk/client-*`).

### Rate Limiting

`utils.js` provides `sleep()` with configurable delays. Used throughout to avoid AWS API throttling:
- Default sleep: 1000ms (configurable via `SLEEP_TIME`)
- Extended sleep: 2000ms (used for critical operations in `cicd.js`)

### Entry Points

The main entry point is **`index.js`**, which routes to four subcommands:
1. **`deploy.js`**: Parses CLI args, calls `cicd.processFunctionEnvironmentVars()`, `cicd.processApiGateway()`, `cicd.processSNS()`
2. **`info.js`**: Lists stages, APIs, SNS topics; aggregates commit info from stage variables and subscriptions
3. **`clean.js`**: Identifies active commits, deletes unused deployments/aliases/versions
4. **`validate.js`**: Validates `cicd.json` against `cicd.schema.json` using AJV

All use `options.js` for CLI argument parsing (supports `--option` and `--option=value` formats).

### Configuration Validation

`validate.js` uses AJV to validate `cicd.json` against `cicd.schema.json`. Schema enforces:
- Required fields and data types
- AWS account ID format (12 digits)
- AWS region format
- HTTP method enums
- Environment variable naming patterns
- Export type constraints (api/sns)

## Key Patterns

### CloudFormation Export Dependency

The system depends on CloudFormation exports matching names in `cicd.json`:
- Export names in config must exactly match CloudFormation export names
- Missing exports cause deployment to exit with error
- All exports resolved at initialization before any deployment operations

### Idempotent Operations

Deployment operations are idempotent:
- Checks for existing versions/aliases/deployments before creating
- Uses "find" helper functions (`findVersion()`, `findAlias()`, `findDeployment()`, etc.)
- Updates existing stages rather than failing

### Stage-Specific Environment Variables

Stage overrides work by:
1. Loading global environment from `cicd.json:environment`
2. Loading stage-specific environment from `stages[].environment`
3. Stage variables override globals (last write wins in `envCache`)
4. SNS topics can be limited to specific stages via `stages` array

### Concurrency Configuration

Functions can specify reserved concurrency via `concurrency` field:
- Value of `0` throttles function (used for Slack APIs to prevent rate limiting)
- Updates provisioned concurrency after alias creation/update
- Only applies to API Gateway functions (not SNS functions in current implementation)

### API Gateway Throttling

API Gateway throttling settings can be configured at two levels:

1. **Global throttling**: Defined in API export configuration (`exports[].throttle`)
   - Applied to all methods/resources in the API
   - Used as default for all stages

2. **Stage-specific throttling**: Defined in stage configuration (`stages[].throttle`)
   - Overrides global throttle settings for specific stages
   - Allows different rate limits for dev/staging/prod environments

**Implementation details** (`apigw.js`):
- Throttling uses AWS API Gateway patch operations when updating stages
- Path format: `/*/*/throttling/rateLimit` and `/*/*/throttling/burstLimit`
- The `/*/*/` prefix applies settings globally to all resource paths and HTTP methods
- Settings are applied via `UpdateStageCommand` with `patchOperations` array
- Both `createStage()` and `updateStage()` support throttle settings

**Important**: The path format must be `/*/*/throttling/...` (not `/throttle/...`) as required by AWS API Gateway's method settings specification.
