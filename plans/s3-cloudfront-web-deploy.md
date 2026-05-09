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
- Same pattern: invoke `cicd.processWeb` when scope includes web. Document the rollback caveat: rolling back to a commit whose S3 folder has been removed by `clean` will fail at the `updateOriginPath` step (the path simply won't have content). v1 acceptable — note in the help text and in this plan; future enhancement is auto-restore from artifact storage.

### `src/info.ts`
- For each `web` export, call `cloudfront.getOriginPath(distributionId, stage)` per stage → parse `/{stage}/{commit}` → extract `commit`
- Render a "Web" row alongside the existing API/SNS/SQS sections, columns: stage, commit, distribution

### `src/clean.ts`
- New phase: for each `web` export
  - Read active commit per stage from CloudFront origin paths → `activeWebCommits: Set<{stage,commit}>`
  - List `s3://{bucket}/` keys grouped by `{stage}/{commit}/` prefix (use the `CommonPrefixes` from `ListObjectsV2` with `Delimiter: '/'`)
  - Delete every `{stage}/{commit}/` group not in the active set
  - Honor `dryRun`: log targets, don't delete

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
- `src/invalidate.ts`

**Modified:**
- `cicd.schema.json` — add `web` branch to `exports.oneOf`
- `src/types.ts` — `WebExportResult`, `WebResult`, plus a `web` variant on the export discriminated union
- `src/shared/cicd.ts` — load web exports in `init()`, add `processWeb()`
- `src/shared/scope.ts` — add `processWeb` / `webFilter`
- `src/deploy.ts` — call `cicd.processWeb`
- `src/rollback.ts` — call `cicd.processWeb`
- `src/info.ts` — render web rows
- `src/clean.ts` — clean unused S3 commit folders
- `src/index.ts` — wire `invalidate` subcommand
- `package.json` — add `@aws-sdk/client-s3`, `@aws-sdk/client-cloudfront`

**No changes:** `src/options.ts` (already handles `--key=value`), `src/shared/utils.ts`, existing wrapper modules.

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
6. **Second deploy + clean:** deploy a second commit, then `node src/index.js clean --dry-run` — output lists the older commit folder for deletion but **not** the new one. Run without `--dry-run` and re-list S3 to confirm.
7. **Invalidate:** `node src/index.js invalidate staging /index.html` — returns an invalidation ID, visible in `list-invalidations`.
8. **Rollback:** `node src/index.js rollback staging --web` — flips origin path back to the prior commit (the prior `s3://.../{commit}/` folder must still exist; expected limitation in v1).
9. **Robots noindex:** with `noindexStages: ["staging"]` configured, deploy to staging and `curl https://staging.<domain>/robots.txt` — must return `User-agent: *\nDisallow: /`. Deploy to prod (not in `noindexStages`) and confirm `robots.txt` is whatever the build produced (or 404 if absent), unmodified by cicd.

---

## Out of scope (v2 candidates, not implemented now)

- `--dark` / `promote` separation (S3 layout already accommodates it; just need the flag + a `promote` subcommand)
- Auto-restore of S3 contents from a build artifact store during rollback when the commit folder has been cleaned
- Per-file content-type/cache-control overrides in `cicd.json`
- Build hook (`build` command run before upload)
- Multi-region distributions
