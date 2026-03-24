# CI/CD Tool Refactoring Plan

## Code Review Summary

### What Works Well
- **Idempotent operations**: Every deployment checks for existing resources before creating (findVersion, findAlias, findDeployment, findMapping)
- **Adaptive retry with exponential backoff**: Smart throttle detection with decay on success
- **Typed result objects**: Good structured return types for deploy/rollback/clean summaries
- **Dual compute mode**: Clean separation of Lambda vs Fargate flows
- **Stage-specific config cascade**: Global → stage → API-level throttle/env resolution

### Critical Issues

1. **Massive code duplication between deploy.ts and rollback.ts** — The summary printing logic (~80 lines) is copy-pasted verbatim. The option-parsing/scope-determination logic (~30 lines) is also duplicated.

2. **Global mutable state in cicd.ts** — Module-level Maps (`exportMap`, `functionMap`, `envCache`, `rawExports`, `psCache`, `stageConfig`) make the system untestable and brittle. State leaks between calls if the module is reused.

3. **Mixed module systems** — TypeScript files use `import` for types but `require()` for all local modules. The `.js` files (github.js, twilio.js, sts.js) should be converted to TypeScript.

4. **process.exit() scattered throughout** — At least 8 locations call `process.exit(-1)` deep inside library code (cicd.ts, getVar, initExports, getStageConfig). This makes error handling impossible for callers and prevents proper cleanup.

5. **Inconsistent error returns** — Some AWS wrappers return `null`/`''` on error, others throw. No structured error types.

6. **SNS function processing is nearly identical to API function processing** — `processSNSFunctions()` (lines 487-515) is a near-clone of `processApiGatewayFunctions()` (lines 344-382), minus concurrency handling.

7. **No dry-run capability** — `--dryRun` exists in the options type but is never implemented. For a deployment tool, this is a significant gap.

8. **`method` required on SNS functions** — The schema requires `method` on all functions via `functionConfig`, but SNS functions don't use HTTP methods. This is a schema modeling error.

---

## Phase 1: Extract Shared Utilities (Low Risk)

### 1.1 Extract summary printer

Create `src/shared/summary.ts` to consolidate the duplicated summary-printing logic from deploy.ts and rollback.ts.

```typescript
// src/shared/summary.ts
export function printDeploymentSummary(results: {
    env?: EnvResult[] | null;
    api?: APIResult | null;
    sns?: SNSResult | null;
    twilio?: TwilioDeployResult | null;
}): string[] { ... }
```

**Files changed**: `deploy.ts`, `rollback.ts`, new `shared/summary.ts`

### 1.2 Extract scope/option resolution

Create `src/shared/scope.ts` to consolidate the duplicated option-to-scope logic.

```typescript
// src/shared/scope.ts
export interface DeployScope {
    processEnv: boolean;
    processApi: boolean;
    processSns: boolean;
    processTwilio: boolean;
    apiFilter: string;
}
export function resolveScope(options: CLIOptions): DeployScope { ... }
export function scopeLabel(scope: DeployScope): string { ... }
```

**Files changed**: `deploy.ts`, `rollback.ts`, new `shared/scope.ts`

### 1.3 Convert .js files to TypeScript

Convert `github.js`, `twilio.js`, and `sts.js` to TypeScript with proper types.

**Files changed**: `github.js` → `github.ts`, `twilio.js` → `twilio.ts`, `sts.js` → `sts.ts`

---

## Phase 2: Refactor cicd.ts (Medium Risk)

### 2.1 Replace process.exit() with thrown errors

Replace all `process.exit(-1)` calls in cicd.ts with proper error throwing. Let the command entry points (deploy.ts, rollback.ts, etc.) be the only places that call `process.exit()`.

**Before:**
```typescript
if (!val) {
    console.log(`VARIABLE ${key} is empty.`);
    process.exit(-1);
}
```

**After:**
```typescript
if (!val) {
    throw new Error(`Environment variable '${key}' resolved to empty value`);
}
```

**Files changed**: `cicd.ts`, add try/catch in `deploy.ts`, `rollback.ts`, `clean.ts`, `info.ts`

### 2.2 Extract version/alias creation into shared function

Deduplicate the version/alias creation logic shared between `processApiGatewayFunctions()` and `processSNSFunctions()`.

```typescript
async function processLambdaVersionAndAlias(
    functionName: string,
    appAlias: string,
    commit: string,
    concurrency?: number
): Promise<{ action: 'created' | 'exists'; version: string }> { ... }
```

**Files changed**: `cicd.ts`

### 2.3 Switch from require() to ES imports

Replace all `require()` calls with proper ES module imports throughout cicd.ts and subcommands.

**Files changed**: All `.ts` files

### 2.4 Encapsulate state in a class (optional, larger effort)

Wrap the module-level Maps and init logic into a `CICDEngine` class to make the system testable and eliminate global state.

```typescript
export class CICDEngine {
    private exportMap = new Map<string, ExportConfig>();
    private functionMap = new Map<string, FunctionConfig>();
    private envCache: Map<string, string> | null = null;
    // ...
    async init(stage: string): Promise<void> { ... }
    async processFunctionEnvironmentVars(): Promise<EnvResult[]> { ... }
    // etc.
}
```

This is the highest-effort item but has the biggest testability payoff. Consider deferring if time-constrained.

**Files changed**: `cicd.ts`, all subcommands

---

## Phase 3: Schema & Configuration Improvements

### 3.1 Split functionConfig into API and SNS variants

The current `functionConfig` definition requires `method` for all functions, but SNS functions don't use HTTP methods.

**Current schema:**
```json
"functionConfig": {
    "required": ["name", "method"],
    "properties": {
        "method": { "enum": ["GET", "POST", ...] }
    }
}
```

**Proposed schema:**
```json
"definitions": {
    "baseFunctionConfig": {
        "type": "object",
        "required": ["name"],
        "properties": {
            "name": { "type": "string", "minLength": 1 },
            "env": { "type": "string", "pattern": "..." },
            "concurrency": { "type": "integer", "minimum": 0 }
        }
    },
    "apiFunctionConfig": {
        "allOf": [
            { "$ref": "#/definitions/baseFunctionConfig" },
            {
                "required": ["method"],
                "properties": {
                    "method": { "enum": ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"] }
                }
            }
        ]
    },
    "snsFunctionConfig": {
        "$ref": "#/definitions/baseFunctionConfig"
    }
}
```

Then reference `apiFunctionConfig` from API exports and `snsFunctionConfig` from SNS exports.

**Files changed**: `cicd.schema.json`, `types.ts` (add `SNSFunctionConfig` without `method`)

### 3.2 Add semantic validation rules

Add cross-field validation that AJV schema alone can't enforce. Implement in `validate.ts`:

- **burstLimit >= rateLimit** — Burst should always be >= steady-state rate
- **SNS `stages` values exist** — Validate that stage names in SNS `stages` arrays match defined stages
- **Fargate stages have `service` + `taskFamily`** — When `computeMode: fargate`, every stage must have these
- **No duplicate function names across exports** — Catch accidental reuse
- **Env var references exist** — Validate that `env` field references exist in `environment`

```typescript
// validate.ts additions
function semanticValidation(config: CICDConfig): string[] {
    const errors: string[] = [];
    const stageNames = new Set(config.stages.map(s => s.stage));

    for (const exp of config.exports || []) {
        if (exp.type === 'sns' && exp.stages) {
            for (const s of exp.stages) {
                if (!stageNames.has(s)) {
                    errors.push(`SNS export '${exp.name}' references undefined stage '${s}'`);
                }
            }
        }
    }
    // ... more checks
    return errors;
}
```

**Files changed**: `validate.ts`

### 3.3 Add environment variable grouping support

The current `env` field uses comma-separated strings which are hard to maintain (see the 10+ variable lists in cicd.json). Consider supporting named groups:

```json
{
    "environmentGroups": {
        "twilio": ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_FROM_PHONE", "TWILIO_CALLBACK_URL", "TWILIO_NOTIFICATION_PHONE_NUMBER"],
        "gcal": ["GCAL_CREDENTIALS", "GCAL_ID"],
        "slack": ["SLACK_COMMAND_TOPIC", "SLACK_BOT_TOKEN", "SLACK_SIGNING_SECRET"]
    }
}
```

Then functions can reference groups: `"env": "@twilio,@gcal,DDB_APPOINTMENTS_TABLE_NAME"`

This dramatically reduces repetition in cicd.json — e.g., the Twilio credential list appears 6 times currently.

**Files changed**: `cicd.schema.json`, `cicd.ts` (resolveVariable/getVars), `types.ts`

### 3.4 Add `description` field to exports and stages

Allow human-readable labels for better `info` output:

```json
{
    "type": "api",
    "name": "ccfw-appointments-api",
    "description": "Appointment booking and management",
    "path": "appointments"
}
```

**Files changed**: `cicd.schema.json`, `info.ts`

---

## Phase 4: Deployment & Rollback Reliability

### 4.1 Implement dry-run mode

Add `--dry-run` support to deploy and rollback. Walk through all operations but don't execute AWS calls. Print what would happen.

Implementation approach: Add a `dryRun` flag that gets passed down through cicd.ts. Each operation logs "WOULD create alias..." instead of calling AWS.

```typescript
// cicd.ts
async function processApiGatewayFunctions(stage, appAlias, commit, apiFilter, dryRun = false) {
    // ... existing find logic ...
    if (dryRun) {
        results.push({ name: functionName, action: 'would-create', version: '(dry-run)' });
        continue;
    }
    // ... existing create logic ...
}
```

**Files changed**: `cicd.ts`, `deploy.ts`, `rollback.ts`

### 4.2 Add deployment verification step

After deploy/rollback, verify the deployment actually took effect:
- Check API Gateway stage variables match expected commit
- Check SNS subscriptions point to expected alias
- For Fargate, verify running task count matches desired

```typescript
// src/shared/verify.ts
export async function verifyDeployment(stage: string, commit: string): Promise<VerificationResult> {
    // Check API stage variables
    // Check SNS subscription endpoints
    // Check Fargate task definition image tag
}
```

**Files changed**: New `shared/verify.ts`, `deploy.ts`, `rollback.ts`

### 4.3 Add rollback safety checks

Before rollback, verify the target commit's Lambda versions/aliases still exist. Currently, if `clean` was run after the target deployment, the rollback would create new versions from `$LATEST` (which may have changed), silently deploying wrong code.

```typescript
async function validateRollbackTarget(commit: string, appAlias: string): Promise<boolean> {
    const functions = await getLambdaExports('api');
    for (const f of functions) {
        const alias = await findAlias(f.value!, appAlias);
        if (!alias) {
            console.warn(`WARNING: Alias '${appAlias}' not found for ${f.value}. Will create from $LATEST.`);
            return false;
        }
    }
    return true;
}
```

**Files changed**: `rollback.ts`, `cicd.ts`

---

## Phase 5: Fargate Restart Command

### 5.1 Add `restart` subcommand

A restart forces new task deployment without changing the image or task definition. Use cases:
- Pick up new environment variables (Parameter Store changes)
- Recover from unhealthy tasks
- Force fresh connections to downstream services

**Implementation:**

```typescript
// src/restart.ts
async function main(): Promise<void> {
    await credentials.validateCredentials();

    const args = options.stripOptions(process.argv.slice(2));
    const o = options.getOptions(process.argv.slice(2));

    if (args.length !== 1) {
        console.log('restart <stage>');
        process.exit(0);
    }

    const stage = args[0];
    const computeMode = (await cicd.getConfig('computeMode')) || 'lambda';

    if (computeMode !== 'fargate') {
        console.error('Error: restart is only available in fargate mode');
        process.exit(1);
    }

    await cicd.setStageConfig(stage);
    const fargateConfig = await cicd.resolveFargateConfig();
    const stageConfig = await cicd.getStageConfig(stage);

    // Option A: Force new deployment (restarts tasks with same task def)
    // This is the ECS equivalent of "restart" — it drains and replaces tasks
    await ecs.updateService(
        fargateConfig.cluster,
        stageConfig.service,
        null, // no task def change
        { forceNewDeployment: true }
    );

    // Wait for stability
    const stable = await ecs.waitForServicesStable(
        fargateConfig.cluster,
        stageConfig.service
    );

    console.log(`Service '${stageConfig.service}' restart ${stable ? 'complete' : 'timed out'}`);
}
```

**Restart with env refresh option (`--env`):**
```bash
node src/index.js restart staging           # Force new deployment (same task def)
node src/index.js restart staging --env     # Re-resolve env vars + register new task def + restart
```

The `--env` variant would:
1. Re-resolve all `!ParameterStore` and `!ImportValue` variables
2. Register a new task definition revision with updated env vars
3. Update the service with the new task definition

**ECS wrapper changes needed:**

```typescript
// ecs.ts - update updateService to support forceNewDeployment
async function updateService(
    cluster: string,
    service: string,
    taskDefinitionArn: string | null,
    options?: { forceNewDeployment?: boolean }
): Promise<void> {
    const ecsClient = await getClient();
    const input: any = { cluster, service };
    if (taskDefinitionArn) input.taskDefinition = taskDefinitionArn;
    if (options?.forceNewDeployment) input.forceNewDeployment = true;
    const command = new UpdateServiceCommand(input);
    await awsRetry(() => ecsClient.send(command));
}
```

**Files changed**: New `src/restart.ts`, `src/index.ts` (add route), `src/shared/ecs.ts` (forceNewDeployment support)

### 5.2 Update index.ts routing

```typescript
case 'restart':
    require('./restart');
    break;
```

### 5.3 Update schema for restart-specific config (optional)

If restart needs configurable behavior (e.g., minimum healthy percent during restart), add to stage config:

```json
{
    "stage": "prod",
    "restart": {
        "minimumHealthyPercent": 100,
        "maximumPercent": 200
    }
}
```

---

## Phase 6: Testing & Quality

### 6.1 Add unit tests for extracted modules

With the refactoring from Phase 1-2, write tests for:
- `scope.ts` — option resolution logic
- `summary.ts` — output formatting
- `cicd.ts` — resolveVariable() (mock PS/CF)
- `validate.ts` — semantic validation

### 6.2 Add integration test scaffolding

Create a mock AWS setup using `aws-sdk-client-mock` for:
- Full deploy flow (Lambda + API Gateway + SNS)
- Rollback flow
- Clean flow
- Fargate deploy + restart

### 6.3 Add consistent logging

Replace all `console.log` in library code (`cicd.ts`, wrapper modules) with `logger.log`/`logger.verbose`. Reserve `console.log` for subcommand output only.

**Files changed**: `cicd.ts`, `lambda.ts`, `apigw.ts`, `sns.ts`, `ecs.ts`

---

## Implementation Priority

| Priority | Phase | Effort | Impact | Risk |
|----------|-------|--------|--------|------|
| 1 | 5.1 Fargate restart command | Small | High | Low |
| 2 | 1.1-1.2 Extract shared utilities | Small | Medium | Low |
| 3 | 2.1 Replace process.exit with errors | Small | High | Low |
| 4 | 3.1 Split function config in schema | Small | Medium | Low |
| 5 | 4.1 Dry-run mode | Medium | High | Low |
| 6 | 2.2 Deduplicate version/alias logic | Small | Medium | Low |
| 7 | 3.2 Semantic validation | Small | Medium | Low |
| 8 | 4.3 Rollback safety checks | Small | High | Low |
| 9 | 3.3 Environment variable groups | Medium | Medium | Low |
| 10 | 1.3 Convert .js to TypeScript | Medium | Low | Low |
| 11 | 4.2 Deployment verification | Medium | Medium | Low |
| 12 | 2.3-2.4 ES imports + class encapsulation | Large | Medium | Medium |
| 13 | 6.1-6.3 Testing & logging | Large | High | Low |

---

## Schema Change Summary

Changes to `cicd.schema.json`:

1. **Split `functionConfig`** into `apiFunctionConfig` (with `method`) and `snsFunctionConfig` (without `method`)
2. **Add `environmentGroups`** — optional object at root level for named variable groups
3. **Add `description`** — optional string on exports and stages
4. **Add `restart`** — optional object on stage config for Fargate restart behavior
5. **Add validation** that `burstLimit >= rateLimit` (semantic, not schema-level)
6. **Add validation** that SNS `stages` entries match defined stage names (semantic)
7. **Consider `computeMode: "fargate"` requiring `service`/`taskFamily` on each stage** — currently not enforced by schema

---

## Migration Notes

- All changes are backwards-compatible with existing `cicd.json` files
- Schema changes add optional fields only; no existing configs will break
- The `restart` command is additive — no existing commands change behavior
- Phase 2 refactoring is internal; external CLI interface stays the same
- Recommended: run `npm run validate` after each schema change to verify
