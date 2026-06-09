# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

This is a custom AWS CI/CD deployment tool for managing Lambda functions, API Gateway, and SNS resources. It reads configuration from `cicd.json` and orchestrates deployments across multiple stages using Git commit-based versioning.

## Core Commands

All commands are accessed through the main CLI tool at `src/index.ts`:

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

# GitHub Deployment metadata (when 'repo' is configured)
node src/index.js deploy <stage> <commit> --description="hotfix: cache fix"  # Override deployment description
node src/index.js deploy <stage> <commit> --transient    # Force transient_environment=true
node src/index.js deploy <stage> <commit> --no-transient # Force transient_environment=false
#   - description defaults to the commit subject line (git log -1 --format=%s), else "Deploy {app}-{commit} to {stage}"
#   - transient_environment is auto-detected: true when the commit is not on the default branch (feature/PR deploys)
#   - production_environment is set true for stages marked "production": true in cicd.json
#   - deploying a "production": true stage prompts for confirmation (bypass with --force; non-TTY requires --force)

# Rollback a stage to a previous deployment
node src/index.js rollback <stage>            # Rollback to the most recent prior successful deployment
node src/index.js rollback <stage> <commit>   # Rollback to a specific commit
node src/index.js rollback <stage> --description="revert bad release"  # Override deployment description

# Options (same as deploy): --env, --api, --sns, --api-filter=<name>, --verbose, --description=<text>
# Requires 'repo' in cicd.json (uses GitHub Deployments API for history)
# Rollback of a "production": true stage shows a PRODUCTION confirmation prompt

# Get deployment information
node src/index.js info              # Show current deployments for all stages
node src/index.js info --details    # Include function versions

# Clean up old deployments
node src/index.js clean             # Remove unused API deployments, Lambda aliases/versions

# Install plugins listed in cicd.json
node src/index.js install           # npm install --save-dev for any plugins missing from node_modules

# Generate CloudFormation for a CloudFront-mapped stage (see "CloudFront API Mapping")
node src/index.js cloudfront <stage>          # Print the Origin + CacheBehavior YAML fragment
node src/index.js cloudfront <stage> --json   # Emit JSON instead of YAML
node src/index.js cloudfront <stage> --api-filter=<api-name>   # Limit to one API
```

## Architecture

### Configuration System (`cicd.json`)

The entire deployment system is driven by `cicd.json`, validated against `cicd.schema.json`. Configuration defines:
- AWS account and region
- Global and stage-specific environment variables
- API Gateway REST APIs with Lambda integrations
- SNS topics with Lambda subscribers
- Stage configurations with custom domain mappings (`stages[].mapping`) and/or CloudFront mappings (`stages[].cloudfront`)
- Per-stage `production: true` flag — marks the stage as a GitHub production environment and gates deploy/rollback behind a confirmation prompt

### Special Environment Variable Resolution

Environment variables support three resolution patterns:
- `!ImportValue <export-name>` - Resolves CloudFormation stack exports
- `!ParameterStore <param-path>` - Resolves AWS Systems Manager parameters
- `!SetEnv <env-var>` - Resolves from process environment variables

Resolution happens in `cicd.ts:resolveEnvironmentVariable()`, with stage-specific overrides applied after global variables.

### Deployment Orchestration (`src/shared/cicd.ts`)

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
   - **APIs**: Creates/updates deployments, stages (with `Commit` variable), and routing (custom domain and/or CloudFront — see below)
   - **Throttling**: Applies global and stage-specific throttle settings using patch operations
   - **Permissions**: Adds Lambda permissions for API Gateway invocation

4. **SNS Deployment** (`processSNS()`)
   - **Functions**: Creates Lambda versions and aliases (same as API Gateway)
   - **Subscriptions**: Removes old subscriptions, adds new ones with aliased function ARN
   - **Permissions**: Adds Lambda permissions for SNS invocation
   - **Stage Filtering**: Honors `stages` array in SNS config to limit deployments

5. **Web Deployment** (`processWeb()` / `processWebRollback()`)
   - For `exports` of `type: "web"` (S3 + CloudFront static sites). Each carries `name`
     (CFN export → S3 bucket) and `distribution` (CFN export → CloudFront distribution ID).
   - **Static origin**: the CloudFront origin path is a fixed `/{stage}/live`, set **once in
     CloudFormation**. The CLI **never mutates the distribution** — that per-deploy rewrite
     caused infrastructure problems and was removed.
   - **S3 layout per stage**:
     - `{stage}/{commit}/` — "dark" build uploaded each deploy; the rollback source.
     - `{stage}/live/` — what CloudFront serves (mirrors the active commit).
     - `{stage}/.cicd-live.json` — `{commit, deployedAt}` marker, written each deploy. Lives
       outside `live/` so the origin can never serve it.
   - **Deploy = pure S3 ops**: upload `{stage}/{commit}/` → `s3.syncPrefix()` copy-then-prune
     into `{stage}/live/` (no empty window) → write the marker → invalidate `/*`. A read-only
     check warns (never changes) if the distribution's origin path is not yet `/{stage}/live`.
   - **Rollback**: re-syncs an existing `{stage}/{commit}/` into `live/` (no upload); errors if
     that prefix was pruned by `clean`.
   - **Live-commit source of truth**: GitHub deployments (via `buildKeepSet`). `info`/`clean`
     read the marker as a backup (used when `repo` is absent) and cross-check; a marker that
     disagrees with GitHub's most-recent commit is reported as drift.
   - **Migration**: point each distribution's origin at `/{stage}/live` in CloudFormation once.
     A deploy populates `{stage}/live/` + marker; until infra is updated the CLI prints a warning.

### CloudFront API Mapping (`stages[].cloudfront`)

An alternative (or addition) to custom-domain base-path mapping: serve a stage's API Gateway
REST APIs through an **existing CloudFront distribution** at a path prefix (e.g. `/api/*`), on
the same domain that already serves the web app — staging stage → staging distribution, prod
stage → prod distribution. `stages[].mapping` (custom domain) and `stages[].cloudfront` are
independent optional fields; a stage may use either or both.

- **Config**: `cloudfront: { distribution, path?, invalidate?, cachePolicy? }`.
  `distribution` is a CFN export name resolving to the distribution ID (resolved in
  `initExports()`, same as web exports). `path` defaults to `"api"`. Each API export composes
  its behavior pattern as `/{cloudfront.path}/{api.prefix}/{api.path}/*` via
  `composeCloudFrontPath()` (mirrors `composeMappingPath()`).
- **CloudFormation owns the infra** — same rule as web: the CLI **never mutates the
  distribution**. The API-Gateway origin (`{apiId}.execute-api.{region}.amazonaws.com`,
  `OriginPath /{stage}`) and the `/api/*` cache behavior + cache policy are defined **once in
  CloudFormation**. Because the API stage name is stable across deploys, the distribution never
  needs to change after initial setup.
- **Deploy** (`processApiGatewayApis()`): deploys the API stage exactly as for custom-domain
  mode, **skips** the base-path mapping, runs a **read-only drift check** per API
  (`cloudfront.getCacheBehavior()` — warns, never fails, if the behavior is missing or its
  origin `OriginPath`/cache policy don't match), and **invalidates** `/{path}/*` once per stage
  (default on; opt out with `invalidate: false`).
- **Generator**: `cicd cloudfront <stage>` (and the drift warning when a behavior is missing)
  prints the ready-to-paste CloudFormation Origin + CacheBehavior fragment via
  `buildCloudFrontFragment()` (`src/shared/cfn-cloudfront.ts`). `DomainName` is emitted as the
  **concrete resolved endpoint** (always valid regardless of stack topology) with commented
  same-stack `!Ref` and cross-stack `Fn::ImportValue` alternatives — `Fn::ImportValue` of an
  export defined in the same stack is circular, so neither form is universally correct. YAML by
  default, `--json` for JSON.

### Versioning Strategy

Git commit-based versioning ties everything together:
- **Lambda version description**: `{app}-{commit}`
- **Lambda alias name**: `{app}-{commit}`
- **API Gateway stage variables**: `Commit: {app}-{commit}`
- **API Gateway deployment description**: `{commit}`

The `info` command reconstructs deployment state by reading API stage variables and SNS subscription endpoints (which contain alias in ARN).

The `rollback` command queries GitHub deployment history via `github.listDeployments()`, identifies successful deployments, prompts for confirmation, then executes the same deploy operations targeting the prior commit. Requires `repo` in `cicd.json`.

The `clean` command identifies active commits from stages/subscriptions, then deletes unused:
- API Gateway deployments
- Lambda aliases (not in active commits)
- Lambda versions (not referenced by active aliases)

### Key Data Structures

The `cicd.ts` module maintains several caches:
- `rawExports`: Map of all CloudFormation exports (name → value)
- `exportMap`: Map of configured exports from `cicd.json` (name → config object with resolved value)
- `functionMap`: Map of all Lambda functions (name → config object with resolved ARN)
- `envCache`: Map of resolved environment variables (key → value)
- `stageConfig`: Current stage configuration object

### AWS SDK Wrappers

All AWS SDK calls go through wrapper modules in `src/shared/`:
- `lambda.ts` - Versions, aliases, permissions, concurrency, environment variables
- `apigw.ts` - Deployments, stages, custom domain mappings, base path mappings
- `sns.ts` - Topic subscriptions, unsubscribe
- `cloudformation.ts` - List exports
- `ps.ts` - Get Parameter Store values
- `sts.js` - Get caller identity
- `github.js` - GitHub Deployments API (create, update status, list deployments)

Each wrapper uses AWS SDK v3 with modular imports (`@aws-sdk/client-*`).

### Plugin System

Non-AWS-native integrations (e.g., Twilio) live in separate npm packages and are loaded at runtime via the `plugins` array in `cicd.json`. See `src/shared/plugin.ts` for the `CICDPlugin` interface, `src/shared/plugins.ts` for the loader, and `src/shared/plugin-runner.ts` for dispatch. A plugin contributes:
- A JSON Schema fragment that merges into `stages[].<configKey>` at validate time
- A `deploy`/`rollback` handler invoked by deploy.ts / rollback.ts
- An `info` handler invoked by info.ts in verbose mode
- An optional `scopeFlag` (default `no<Name>`) to skip the plugin for a single invocation

The Twilio integration is the reference plugin and lives in its own repo at [`abwaters/cicd-plugin-twilio`](https://github.com/abwaters/cicd-plugin-twilio), published to GitHub Packages as `@abwaters/cicd-plugin-twilio`.

### Rate Limiting

`utils.ts` provides `sleep()` with configurable delays. Used throughout to avoid AWS API throttling:
- Default sleep: 1000ms (configurable via `SLEEP_TIME`)
- Extended sleep: 2000ms (used for critical operations in `cicd.js`)

### Entry Points

The main entry point is **`index.ts`**, which routes to five subcommands:
1. **`deploy.ts`**: Parses CLI args, calls `cicd.processFunctionEnvironmentVars()`, `cicd.processApiGateway()`, `cicd.processSNS()`, then dispatches to registered plugins via `runPlugins('deploy', ...)`
2. **`rollback.ts`**: Fetches GitHub deployment history, prompts for confirmation, then reuses the same `cicd.*` functions as deploy to rollback to a prior commit
3. **`info.ts`**: Lists stages, APIs, SNS topics; aggregates commit info from stage variables and subscriptions
4. **`clean.ts`**: Identifies active commits, deletes unused deployments/aliases/versions
5. **`validate.ts`**: Validates `cicd.json` against `cicd.schema.json` using AJV

All use `options.ts` for CLI argument parsing (supports `--option` and `--option=value` formats).

### Configuration Validation

`validate.ts` uses AJV to validate `cicd.json` against `cicd.schema.json`. Schema enforces:
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

**Implementation details** (`apigw.ts`):
- Throttling uses AWS API Gateway patch operations when updating stages
- Path format: `/*/*/throttling/rateLimit` and `/*/*/throttling/burstLimit`
- The `/*/*/` prefix applies settings globally to all resource paths and HTTP methods
- Settings are applied via `UpdateStageCommand` with `patchOperations` array
- Both `createStage()` and `updateStage()` support throttle settings

**Important**: The path format must be `/*/*/throttling/...` (not `/throttle/...`) as required by AWS API Gateway's method settings specification.
