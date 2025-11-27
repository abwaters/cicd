# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

This is a custom AWS CI/CD deployment tool for managing Lambda functions, API Gateway, and SNS resources. It reads configuration from `cicd.json` and orchestrates deployments across multiple stages (prod, staging, tools).

## Core Commands

Run commands from the repository root:

```bash
# Deploy a commit to a stage
node src/deploy.js <stage> <commit>

# Deploy with options
node src/deploy.js <stage> <commit> --env          # Only update environment variables
node src/deploy.js <stage> <commit> --api          # Only update API Gateway
node src/deploy.js <stage> <commit> --sns          # Only update SNS topics
node src/deploy.js <stage> <commit> --api-filter=<api-name>  # Deploy specific API

# Get deployment information
node src/info.js                    # Show current deployments for all stages
node src/info.js --details          # Include function versions

# Clean up old deployments
node src/clean.js                   # Remove unused API deployments, Lambda aliases/versions

# Validate configuration
node src/validate.js                # Validate cicd.json against schema
npm run validate                    # Alternative using npm script
```

## Architecture

### Configuration System (`cicd.json`)

The deployment system is driven entirely by `cicd.json`, which defines:
- AWS account and region
- Environment variables (with special prefixes for CloudFormation imports, SSM parameters, and local env vars)
- API Gateway configurations with Lambda functions
- SNS topic configurations with Lambda subscribers
- Stage-specific configurations and domain mappings

### Configuration Validation

A JSON Schema (`cicd.schema.json`) is provided to validate the structure of `cicd.json`:
- Run `npm run validate` or `node src/validate.js` to validate your configuration
- The schema validates required fields, data types, and structure
- Validation is recommended before deploying to catch configuration errors early

### Special Environment Variable Syntax

Environment variables in `cicd.json` support three resolution patterns:
- `!ImportValue <export-name>` - Resolves CloudFormation stack exports
- `!ParameterStore <param-path>` - Resolves AWS Systems Manager parameters
- `!SetEnv <env-var>` - Resolves from process environment variables

### Deployment Flow

The `cicd.js` module orchestrates deployments in this order:
1. Initialize exports from CloudFormation stacks
2. Resolve environment variables (CloudFormation, SSM, local env)
3. Update Lambda function environment variables
4. Create Lambda versions and aliases for the commit
5. Create/update API Gateway deployments and stages
6. Configure custom domain mappings
7. Update Lambda permissions for API Gateway or SNS triggers
8. Subscribe Lambda functions to SNS topics (cleaning up old subscriptions)

### Resource Organization

Resources are organized by type in the `exports` array of `cicd.json`:
- `type: "api"` - API Gateway REST APIs with Lambda integrations
- `type: "sns"` - SNS topics with Lambda subscribers

Each export references CloudFormation stack exports by name. The system:
1. Loads all CloudFormation exports at startup
2. Matches them to configured resources
3. Uses the resolved ARNs/IDs for deployments

### Shared Modules (`src/shared/`)

- `cicd.js` - Core orchestration logic
- `config.js` - Loads and caches `cicd.json`
- `options.js` - Command-line argument parser
- `lambda.js` - AWS Lambda SDK wrapper (versions, aliases, permissions, concurrency)
- `apigw.js` - API Gateway SDK wrapper (deployments, stages, mappings)
- `sns.js` - SNS SDK wrapper (subscriptions)
- `cloudformation.js` - CloudFormation exports lookup
- `ps.js` - Parameter Store value resolution
- `sts.js` - AWS STS for account identity
- `utils.js` - Sleep utilities for rate limiting

### Validation Module (`src/validate.js`)

- `validate.js` - JSON Schema validation for `cicd.json` configuration
  - Uses AJV (Another JSON Schema Validator) library
  - Validates against `cicd.schema.json`
  - Provides detailed error messages for invalid configurations

### Versioning Strategy

Lambda functions use Git commit-based versioning:
- Lambda version description: `<commit-hash>`
- Lambda alias name: `<app>-<commit-hash>`
- API Gateway stage variables include `Commit: <app>-<commit-hash>`
- Deployment descriptions include commit hash for tracking

### Stage Management

Stages are configured with:
- Custom domain mapping (domain + base path)
- Stage-specific environment variables
- Stage-specific SNS topic filtering

The info command shows which commits are deployed to each stage by reading:
- API Gateway stage variables
- SNS subscription endpoints (which include the alias in the ARN)

### Cleanup Process (`clean.js`)

The cleanup script:
1. Identifies active commits from API stages and SNS subscriptions
2. Deletes unused API Gateway deployments
3. Deletes Lambda aliases not referenced by active commits
4. Deletes Lambda versions not referenced by active aliases

This keeps the AWS resources lean and prevents accumulation of old versions.

## AWS SDK Version

Uses AWS SDK v3 (`@aws-sdk/client-*` packages) with modular imports.
