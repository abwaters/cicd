# Add S3 + CloudFront web deployment support to the cicd tool

## Context

The cicd tool currently deploys Lambda-backed services (API Gateway, SNS, SQS, Workers, Fargate). It has no model for static-site deployments, so projects like `ccfw-www` (non-Vite SSG, builds to `./dist/`) sit outside the standard `deploy <stage> <commit>` flow and don't show up in `info`/`clean`/`rollback` or in GitHub Deployments per stage.

This change adds a first-class **`web`** export type that mirrors the `api`/`sns`/`sqs` patterns:
- Static artifacts uploaded to a deterministic, per-stage, per-commit S3 path
- A single CloudFront distribution with one origin per stage (host-header behaviors, custom domains per stage); deploys atomically flip the *origin path* of the stage's origin to the new commit folder, then issue an invalidation
- Each `web` deploy participates in the existing GitHub Deployments lifecycle (per-stage environment, `in_progress` → `success`/`failure`)
- Future-friendly to dark deploys (the `{stage}/{commit}/` layout already separates upload from promotion), but **v1 always uploads + promotes** — no `--dark` flag yet

Decisions captured from clarifying questions:
- **CF topology:** single distribution, one origin per stage, host-header behaviors, custom domains per stage (matches the existing `mapping.domain` pattern in stage config)
- **Promotion model:** v1 = always upload+promote in one step
- **Source convention:** hardcoded `./dist/` (matches `ccfw-www` SSG output)
- **CLI:** `--web` / `--web-filter=<name>` flags everywhere `--api` is supported, plus a new top-level `invalidate <stage> [paths...]` subcommand
- **Commit folder:** use git's default short hash (the same `commit` value already passed to `deploy`)
- **Infra ownership:** S3 bucket + CloudFront distribution live in a separate repo / are managed manually. The cicd tool consumes their CFN exports by name and only flips the per-stage origin path + invalidates.

---

## S3 + CloudFront layout

```
s3://<bucket>/
  prod/
    abc1234/        # full ./dist/ contents for that commit
      index.html
      assets/...
    def5678/
  staging/
    ...
```

CloudFront distribution (created/maintained outside cicd):
- One origin per stage, e.g. `OriginId: prod`, `OriginId: staging`, all pointing at the same S3 bucket
- Each origin's `OriginPath` is what cicd flips at deploy time → `/{stage}/{commit}`
- Cache behaviors route by host (e.g. `www.ccfw.example` → `prod` origin, `staging.ccfw.example` → `staging` origin)
- Distribution ID and bucket name exported from CFN; cicd consumes them by name

The cicd tool **does not** create or modify behaviors / origins / domains — it only edits the `OriginPath` on the existing per-stage origin and issues invalidations. The infra owns shape; cicd owns the pointer to the live commit.

Convention: **CloudFront `OriginId` == stage name**. No new fields in stage config required.

---

## Schema changes — `cicd.schema.json`

Add a third branch to the `exports` `oneOf`:

```jsonc
{
  "type": "object",
  "description": "S3/CloudFront static-site deployment",
  "required": ["type", "name", "distribution"],
  "properties": {
    "type":           { "const": "web" },
    "name":           { "type": "string", "description": "CloudFormation export → S3 bucket name" },
    "distribution":   { "type": "string", "description": "CloudFormation export → CloudFront distribution ID" },
    "stages":         { "type": "array", "items": { "type": "string" } },   // optional, like sns/sqs
    "source":         { "type": "string", "description": "Override default ./dist/ source" },  // optional escape hatch
    "noindexStages":  { "type": "array", "items": { "type": "string" }, "description": "Stages where cicd injects a Disallow:/ robots.txt (overriding any source robots.txt). Always also applied to dark deploys in v2." }
  }
}
```

Stage config is **unchanged** (origin ID derived from stage name; custom domain already lives in `stages[].mapping.domain`).

Example `cicd.json` block:
```jsonc
{
  "type": "web",
  "name": "ccfw-www-bucket",
  "distribution": "ccfw-www-distribution",
  "noindexStages": ["staging", "dev"]
}
```

---

## Robots noindex injection

Goal: keep search engines off non-production deployments without requiring the build pipeline to produce a stage-aware artifact.

Behavior:
- For any stage listed in the export's `noindexStages`, `processWeb()` injects a synthetic `robots.txt` into the upload alongside the `./dist/` contents:
  ```
  User-agent: *
  Disallow: /
  ```
- The injected file overrides any `robots.txt` present in `./dist/` for that stage's upload only — it does **not** mutate the local source tree, just the uploaded object at `s3://{bucket}/{stage}/{commit}/robots.txt`.
- Stages not in `noindexStages` upload whatever (or nothing) the build produced; cicd does not touch their `robots.txt`.
- Cache-control on the injected `robots.txt` is `no-cache, no-store, must-revalidate` (treated like HTML), so flipping a stage in/out of `noindexStages` takes effect on next deploy without lingering in CDN caches.

Implementation:
- New helper in `src/shared/s3.ts`: `putObject(bucket, key, body, contentType, cacheControl)` — small wrapper around `PutObjectCommand` for arbitrary in-memory content.
- In `processWeb()`, after `s3.uploadDirectory(...)` for each stage, if `stage ∈ export.noindexStages`, call `s3.putObject(bucket, '{stage}/{commit}/robots.txt', '<body>', 'text/plain', 'no-cache, no-store, must-revalidate')`.
- Dry-run mode logs `WOULD inject robots.txt (Disallow: /)` like other mutating calls.

Forward-looking — dark deploys (v2):
- When `--dark` lands, dark uploads should **always** get the synthetic `Disallow: /` robots.txt regardless of stage, since darks are by definition not the public-facing deployment for that host. The `noindexStages` config still governs the production-stage flips.

---

## New AWS SDK wrapper modules

Both follow the existing wrapper pattern (lazy singleton client, `awsRetry()`, named exports, region from `getConfig('region')`).

### `src/shared/s3.ts` — new
- `uploadDirectory(bucket, keyPrefix, localDir, contentTypeFor, cacheControlFor)` — walks `localDir` recursively, issues `PutObjectCommand` per file with derived `ContentType` and `CacheControl`
- `putObject(bucket, key, body, contentType, cacheControl)` — single-object upload for synthetic content (e.g. injected `robots.txt`)
- `listObjectsByPrefix(bucket, prefix)` — paginated `ListObjectsV2Command`
- `listCommonPrefixes(bucket, prefix, delimiter)` — `ListObjectsV2Command` with `Delimiter` for `{stage}/{commit}/` enumeration
- `deleteObjects(bucket, keys)` — `DeleteObjectsCommand` in batches of 1000
- Cache-control rules:
  - `*.html` → `no-cache, no-store, must-revalidate`
  - Everything else (hashed assets) → `public, max-age=31536000, immutable`
- Content-Type derived via a small built-in map (`html, css, js, mjs, json, svg, png, jpg, jpeg, gif, woff, woff2, ico, txt, map`); fall back to `application/octet-stream`. **No new `mime-types` dep** — keep deps lean.

### `src/shared/cloudfront.ts` — new
- `getDistributionConfig(distributionId)` — returns `{ ETag, DistributionConfig }`
- `updateOriginPath(distributionId, originId, originPath)` — fetches config + ETag, mutates `Origins.Items[].OriginPath` for the matching `Id`, sends `UpdateDistributionCommand` with `IfMatch: ETag`. Throws if origin id not found.
- `createInvalidation(distributionId, paths)` — `CreateInvalidationCommand`, `CallerReference` = `cicd-{Date.now()}`
- `getOriginPath(distributionId, originId)` — convenience for `info`/`clean`

### Dependencies — `package.json`
Add to `dependencies`:
- `@aws-sdk/client-s3` (^3.1042.0 — match existing AWS SDK pinning)
- `@aws-sdk/client-cloudfront` (^3.1042.0)

No other new deps.

---

## Orchestration — `src/shared/cicd.ts`

Add a `processWeb()` modeled on `processApiGateway()` / `processSNS()`.

```typescript
async function processWeb(
    stage: string,
    appAlias: string,    // accepted for symmetry; web doesn't use it
    commit: string,
    webFilter?: string,
    dryRun: boolean = false
): Promise<WebResult>
```

For each `web` export (respecting `webFilter` and `stages` array):
1. Resolve `bucket = exportMap[export.name].value` and `distributionId = exportMap[export.distribution].value`
2. Resolve `source = export.source ?? './dist'` (relative to `process.cwd()`)
3. Validate `source` exists and is non-empty (fail loud — a silent no-op upload is worse than an error)
4. **Upload** `source/**` → `s3://{bucket}/{stage}/{commit}/` (via `s3.uploadDirectory`)
5. **Inject `robots.txt`** if `stage ∈ export.noindexStages` (or in v2, if this is a dark deploy) — overwrites any `robots.txt` from the source for this stage's upload (see "Robots noindex injection" above)
6. **Promote**: `cloudfront.updateOriginPath(distributionId, stage, '/' + stage + '/' + commit)`
7. **Invalidate**: `cloudfront.createInvalidation(distributionId, ['/*'])`
8. Skip every AWS-mutating call when `dryRun` (log "WOULD ..." like other process functions)

Return `WebResult` with per-export `{ bucket, distribution, originPath, invalidationId, fileCount, totalBytes }`.

Result types added to `src/types.ts`:
```typescript
export interface WebExportResult {
    name: string;
    bucket: string;
    distribution: string;
    originPath: string;
    invalidationId?: string;
    fileCount: number;
    totalBytes: number;
    noindexInjected: boolean;
}
export interface WebResult { exports: WebExportResult[]; }
```

Also: load `web` exports inside `init()` / `initExports()` the same way `api`/`sns`/`sqs` exports are loaded today (so `exportMap` resolves both the bucket and distribution names from CFN at startup).

---

## Unified clean policy

`clean` keeps the **last N successful deployments per stage** as the source of truth across all three compute modes (web, lambda, fargate). It does not infer from live infrastructure — GitHub Deployments is the ground truth for what's recoverable, and `N` is the rollback window.

### Keep-set construction

```
for each stage in cicd.json.stages:
    keep[stage] = github.listDeployments(env=stage, state=success)
                    .slice(0, N)
                    .map(d => d.sha)
```

`N` is a single CLI flag — `--keep=N` — applied uniformly across all phases. Default: **5**. The active commit is always position 0 (rollback creates a new deployment record on the same env, so it bubbles to the top), so the keep set inherently includes "what's serving traffic right now." No live-infra query is needed to build it.

### `N` is the rollback window

`rollback <stage> <commit>` validates `commit ∈ keep[stage]` before any infra changes and fails fast with a clear "outside the rollback window" message if not. This makes the v1 web caveat about rolling back to a cleaned folder obsolete — across all modes, what's not in the keep set is not rollback-able, and the user finds out before any AWS calls fire.

### Per-mode artifact map

Each phase walks a different artifact taxonomy with the same per-stage scoping rules.

#### Web
| Artifact | Scope | Keep rule |
|---|---|---|
| `s3://{bucket}/{stage}/{commit}/` | Per stage | `commit ∈ keep[stage]` |

#### Lambda
| Artifact | Scope | Keep rule |
|---|---|---|
| API Gateway deployments | Per REST API, pooled across its stages | `description ∈ ∪ keep[stage]` over stages on this API |
| Lambda aliases (`{app}-{commit}`) | Per function, shared across stages | `commit ∈ ∪ keep[stage]` over stages where this function deploys |
| Lambda versions | Per function | Reachable from a kept alias |

Functions inherit the union from their declared stages: SNS / SQS / worker functions narrow to their `stages` array; API and stageless functions union over all top-level stages.

**Order within phase:** delete API GW deployments → delete aliases → delete unreferenced versions. Versions cannot be deleted while aliases reference them.

#### Fargate
| Artifact | Scope | Keep rule |
|---|---|---|
| ECS task definition revisions | Per stage (`taskFamily` is per stage) | Image tag's commit ∈ `keep[stage]` |
| ECR images (tag = commit) | Shared across stages | Tag ∈ `∪ keep[stage]` across all stages |

**Order within phase:** deregister/delete task defs first → then delete ECR images. ECR refuses to delete images still referenced by a task definition revision.

### Drift detection (uniform across modes)

For each stage, compare `recent[0]` against the live pointer:

| Mode | Live pointer |
|---|---|
| web | CloudFront origin's `OriginPath` |
| lambda | API stage `Commit` variable + SNS subscription alias ARN |
| fargate | ECS service's current task definition revision (image tag) |

If they disagree, log a warning during `clean` and `info` — likely cause is a manual change outside cicd. Don't fail; just surface it.

### Phase orchestration

`clean` runs three phases sequentially: web → lambda → fargate. Each phase no-ops when the project doesn't declare that artifact type (no `web` exports → skip web phase; `computeMode != fargate` → skip fargate phase). The keep-set map is built once at the top and shared across phases.

`--dry-run` prints the keep set per stage, then the deletion plan per phase, with no AWS-mutating calls.

---

## CLI plumbing

### `src/shared/scope.ts`
Add `processWeb` boolean and `webFilter` string:
- New flag `--web` mirrors `--api` semantics (when any `--<type>` flag is passed, only that type runs; without flags, everything runs)
- New flag `--web-filter=<name>` mirrors `--api-filter`

### `src/deploy.ts`
- Destructure `processWeb` and `webFilter` from `resolveScope(o)`
- After the `processSqs` block (line ~133), add:
  ```typescript
  if (processWeb) {
      webResults = await cicd.processWeb(stage, appAlias, commit, webFilter, dryRun);
  }
  ```
- Web participates in the **existing** GitHub Deployment block at lines 51–98 / 144–166 — no new GitHub code paths needed; `environment: stage` already gives per-stage tracking, satisfying "update GitHub deployments per stage".

### `src/rollback.ts`
- Invoke `cicd.processWeb` when scope includes web (same pattern as deploy).
- **Validate against keep window upfront**: before any infra changes, fetch `keep[stage]` (last N successful deployments) and refuse if the requested commit isn't in it. Print `commit {commit} is outside the rollback window for {stage} (keep window = N=5); use 'info' to see recoverable commits.` This validation applies across all three modes — web / lambda / fargate — and replaces the prior v1 caveat about rolling back to cleaned S3 folders. `clean` and `rollback` now agree on what's recoverable.

### `src/info.ts`
- For each `web` export, call `cloudfront.getOriginPath(distributionId, stage)` per stage → parse `/{stage}/{commit}` → extract `commit`
- Render a "Web" row alongside the existing API/SNS/SQS sections, columns: stage, commit, distribution

### `src/clean.ts`
- Build `keep[stage]` once at the top via `github.listDeployments(env=stage, state=success).slice(0, N)` — see "Unified clean policy" above for the full policy across web / lambda / fargate.
- Read `--keep=N` from `options.ts` (default 5).
- Replace the existing "active commits from API stages + SNS subscriptions" logic with the keep-set policy across all three phases:
  - **Web phase**: for each `web` export, list `s3://{bucket}/` `CommonPrefixes` per stage; delete any `{stage}/{commit}/` whose `commit ∉ keep[stage]`.
  - **Lambda phase**: rewrite to consume keep-set unions instead of the live "active commits" set. API GW deployments scoped per REST API; aliases scoped per function over the function's declared stages; versions reachable from kept aliases. Ordering: deployments → aliases → versions.
  - **Fargate phase** (new): for each stage's `taskFamily`, deregister + delete revisions whose image commit ∉ `keep[stage]`. Then delete ECR images whose tag ∉ ∪ `keep[stage]`. Ordering: task defs → ECR.
- Drift warnings: query the live pointer per mode (CloudFront origin path / API stage variable / ECS service task def) and warn if it ≠ `recent[0]`. Non-fatal.
- `--dry-run`: print keep set per stage, then deletion plan per phase. No AWS mutations.

### `src/invalidate.ts` — **new** top-level subcommand
- Usage: `node src/index.js invalidate <stage> [path1 path2 ...]`
- Defaults paths to `['/*']`
- Resolves all `web` exports for the stage, calls `cloudfront.createInvalidation` on each, prints invalidation IDs
- Add a route entry in `src/index.ts` next to `info`/`clean`

### `src/index.ts`
- Register the new `invalidate` subcommand alongside `deploy`/`rollback`/`info`/`clean`/`validate`

### `src/validate.ts`
- No code change needed — AJV picks up the schema addition automatically.

---

## Files to modify / create

**New:**
- `src/shared/s3.ts`
- `src/shared/cloudfront.ts`
- `src/shared/ecr.ts` — list/batch-delete ECR images by tag (for fargate clean)
- `src/shared/ecs.ts` — list/deregister/delete task definition revisions (for fargate clean)
- `src/invalidate.ts`

**Modified:**
- `cicd.schema.json` — add `web` branch to `exports.oneOf`
- `src/types.ts` — `WebExportResult`, `WebResult`, plus a `web` variant on the export discriminated union
- `src/shared/cicd.ts` — load web exports in `init()`, add `processWeb()`
- `src/shared/scope.ts` — add `processWeb` / `webFilter`
- `src/shared/github.js` — add `listSuccessfulDeployments(env, limit)` helper if not already present (consumed by both `clean` and `rollback`)
- `src/deploy.ts` — call `cicd.processWeb`
- `src/rollback.ts` — call `cicd.processWeb`; validate target commit is in the keep window before any infra change
- `src/info.ts` — render web rows; surface drift warnings (live pointer ≠ `recent[0]`) per mode
- `src/clean.ts` — full rewrite to the unified keep-set policy across all three phases (web / lambda / fargate); read `--keep=N` (default 5)
- `src/index.ts` — wire `invalidate` subcommand
- `package.json` — add `@aws-sdk/client-s3`, `@aws-sdk/client-cloudfront`. (`@aws-sdk/client-ecr` and `@aws-sdk/client-ecs` are already present from fargate mode.)

**No changes:** `src/options.ts` (already handles `--key=value`, so `--keep=N` parses without modification), `src/shared/utils.ts`, existing wrapper modules.

---

## Verification

1. **Schema:** `npm run validate` against a `cicd.json` that includes a `web` export — should pass; intentionally malformed (missing `distribution`) should fail with a clear AJV error.
2. **Build:** `npm run build` produces `dist/shared/s3.js`, `dist/shared/cloudfront.js`, `dist/invalidate.js` with no TS errors.
3. **Dry run end-to-end:** `node src/index.js deploy staging <commit> --web --dry-run` prints the planned S3 uploads, the CloudFront origin update, and the invalidation, without making AWS calls.
4. **Real deploy (staging):** `node src/index.js deploy staging <commit> --web`. Confirm:
   - `aws s3 ls s3://<bucket>/staging/<commit>/` shows the artifacts
   - `aws cloudfront get-distribution-config --id <id>` shows `staging` origin's `OriginPath = /staging/<commit>`
   - `aws cloudfront list-invalidations --distribution-id <id>` shows a fresh invalidation
   - `gh api /repos/<repo>/deployments?environment=staging` shows the new deployment with `status: success`
5. **Info:** `node src/index.js info` — staging row reports the freshly-deployed commit.
6. **Second deploy + clean (keep window):** deploy 6+ commits to staging, then `node src/index.js clean --keep=5 --dry-run` — output lists the keep set per stage (5 most recent successful deployments), then the deletion plan: web folders, Lambda aliases, Fargate task defs, and ECR images for any commit outside the union. Run without `--dry-run` and re-list S3 / Lambda / ECR to confirm. With `--keep=2`, the deletion list grows accordingly.
7. **Invalidate:** `node src/index.js invalidate staging /index.html` — returns an invalidation ID, visible in `list-invalidations`.
8. **Rollback within window:** `node src/index.js rollback staging --web` — flips origin path back to the prior commit (still in keep window, so its S3 folder is intact).
9. **Rollback outside window (failure mode):** ask to roll back to a commit older than the keep window. The command must fail fast with `commit {sha} is outside the rollback window for staging (keep window = N=5)` before any AWS calls. No infra changes occur.
10. **Drift warning:** manually edit the staging CloudFront origin's `OriginPath` (or an ECS service's task def) to a stale commit, then run `node src/index.js info` — output highlights the drift (live pointer ≠ `recent[0]`). `clean` likewise warns but does not fail.
11. **Robots noindex:** with `noindexStages: ["staging"]` configured, deploy to staging and `curl https://staging.<domain>/robots.txt` — must return `User-agent: *\nDisallow: /`. Deploy to prod (not in `noindexStages`) and confirm `robots.txt` is whatever the build produced (or 404 if absent), unmodified by cicd.

---

## Out of scope (v2 candidates, not implemented now)

- `--dark` / `promote` separation (S3 layout already accommodates it; just need the flag + a `promote` subcommand)
- Per-stage `--keep=N` overrides (current design: one global N)
- Untagged ECR image cleanup beyond commit-tagged images
- Per-file content-type/cache-control overrides in `cicd.json`
- Build hook (`build` command run before upload)
- Multi-region distributions

Note: the prior v2 candidate "auto-restore of S3 contents during rollback" is dropped. Under the unified keep-set policy, rollback validates the target commit against the keep window before any infra change, so the cleaned-folder scenario is now a fast-fail rather than a silent failure.
