# Infrastructure Models

This is the conceptual companion to the [README](../README.md) (reference) and [QUICKSTART](../QUICKSTART.md) (tutorial). It explains the infrastructure models this tool supports and — more importantly — *why* they are shaped the way they are. Nothing here is required reading to operate the tool, but everything the tool does follows from the ideas on this page.

## The Opinion

This is an opinionated tool. Its goals are narrow and deliberate:

- **Low-cost infrastructure** — as close to zero cost at zero usage as AWS allows.
- **Simple staged deployments** — dev, staging, prod (or whatever stages you define), each an independent target.
- **Simple, quick rollbacks** — returning to the prior release should take seconds, not a rebuild.

To deliver that, the tool makes assumptions. If they don't fit your world, this tool isn't for you — and that's by design.

### You use AWS

All infrastructure is AWS: Lambda, API Gateway, S3, CloudFront, SNS, SQS, ECS/Fargate. There is no cloud-abstraction layer and no plan for one.

### You use CloudFormation — but only for what it's good at

CloudFormation is **schematically consistent but behaviorally fragmented**. It gives you one declarative schema for everything, but per-resource update behavior is unpredictable — some updates happen in place, some force replacement, stack updates are slow, and drift is a way of life. And it has no real notion of CI or CD.

So the tool draws a hard line:

- **CloudFormation owns durable, rarely-changing infrastructure**: the API Gateways, Lambda functions, buckets, distributions, topics, queues, clusters. These change when your architecture changes.
- **This tool owns the high-frequency deploy/rollback path**, using direct, well-understood API operations: Lambda versions and aliases, API Gateway deployments and stages, S3 syncs, ECS task-definition revisions. These change on every release.

The contract between the two layers is **CloudFormation exports**. Every resource named in `cicd.json` resolves through an export (`!ImportValue`), and the tool never mutates infrastructure — it never edits a CloudFront distribution, never restructures an API, never touches a stack. It only moves *releases* through infrastructure that CloudFormation already built.

### You use GitHub

The git commit is the unit of release, and the **GitHub Deployments API is the ledger**: every deploy and rollback is recorded as a GitHub deployment with environment, status, and commit. Rollback works by reading that ledger — `cicd rollback <stage>` finds the most recent prior successful deployment and re-points the infrastructure at it.

### You follow the patterns

Git commits version everything, uniformly:

| Artifact | Versioned as |
|---|---|
| Lambda version & alias | `{app}-{commit}` |
| API Gateway stage variable | `Commit: {app}-{commit}` |
| S3 web build prefix | `{stage}/{commit}/` |
| ECS task definition | revision pinned to the commit's image tag |

Because every release artifact is keyed by commit and prior artifacts are retained, **deploy and rollback are the same operation pointed at different commits**.

### The economic thesis: cost follows usage, starting at ~zero

Every default building block is serverless and usage-priced: Lambda, API Gateway, S3, CloudFront, SNS, SQS. An application deployed this way with zero traffic costs effectively nothing — and one with little traffic costs little. There is real per-request inefficiency in this model, and that's an accepted trade: the inefficiency only matters once you have the usage to feel it, and by then the usage justifies graduating to a capacity-priced tier (Lambda → Fargate, see below). The architecture is designed so that scale-out can continue beyond Fargate to larger dedicated compute as the economics demand.

## Shared Concepts

Both high-level models — API and WWW — share the same release machinery.

**Stages.** Each stage (dev, staging, prod, …) is an independent deployment target with its own environment variables, domain mapping, and throttle settings. A stage marked `"production": true` is reported to GitHub as a production environment and gates deploys and rollbacks behind a confirmation prompt.

**Commit-based versioning.** Every deployable artifact is keyed by the git commit, so the state of a stage is always answerable ("which commit is live?") and reproducible.

**Rollback as a first-class peer of deploy.** Prior releases stay warm — Lambda versions and aliases are retained, S3 dark builds are retained — until `cicd clean` deliberately prunes them. Rolling back never rebuilds anything; it re-points existing infrastructure at an existing artifact.

**GitHub Deployments as the ledger.** Deployment history, status, and environment metadata live in GitHub, where they're visible next to the code that produced them.

## The API Model

### The per-method Lambda opinion

The unit of compute — and therefore the unit of cost and scale — is **one Lambda function per resource path + HTTP method**. An API export in `cicd.json` is a *crud cluster*: a path with a function bound to each verb.

```
api.domain.com/orders   GET     → orders-get-function
                        POST    → orders-post-function
                        PUT     → orders-put-function
                        DELETE  → orders-delete-function
```

This is deliberate, and monolithic ("one Lambda serves the whole API") deployments are deliberately unsupported. The reasoning: **method usage doesn't scale uniformly**. The GET that gets hammered scales and bills independently of the DELETE that's called twice a month. Per-method functions mean your bill and your concurrency follow the actual shape of your traffic, method by method — and each method can be tuned (memory, reserved concurrency, environment) independently.

The accepted trade is per-invocation inefficiency: cold starts, per-request pricing, duplicated bootstrap. That inefficiency is fine right up until sustained volume makes a capacity-priced model cheaper — which is exactly the point where you switch sub-models (see Fargate, below) rather than restructure your API.

### Release mechanics

Each deploy creates a Lambda **version** and **alias** named `{app}-{commit}` for every function, then creates an API Gateway deployment and updates the stage, recording the commit in a stage variable. Rollback re-points aliases and the stage at a prior commit's artifacts — no rebuild, no repackaging.

### The three sub-models

The first two sub-models are about **surface exposure** — how the API surfaces to the world. The third is about **compute** — what runs behind the surface.

#### 1. Dedicated domain exposure

The API gets its own domain. API Gateway is deployed behind a custom domain (`api.domain.com`), and each API export is base-path-mapped under it:

```
api.domain.com/orders/...      ← orders API
api.domain.com/customers/...   ← customers API
```

The mapped path composes from the stage mapping path, an optional per-API `prefix` (for grouping APIs under a shared segment, e.g. `/admin/orders`), and the API's `path`. This is the natural mode when the API is a product surface in its own right, or when web and API are operated by different teams or on different domains.

#### 2. Web path exposure

The API rides under the *website's* domain. The www CloudFront distribution carries a second origin with a cache behavior routing `www.domain.com/api/*` to API Gateway:

```
www.domain.com/*          → CloudFront origin 1: S3 static site
www.domain.com/api/*      → CloudFront origin 2: API Gateway
```

One domain serves both the static site and the API — no CORS between them, one certificate, one DNS record. The division of labor holds here too: **CloudFormation owns the distribution** (its origins and behaviors are infrastructure), while this tool deploys the API Gateway stage behind it.

#### 3. Fargate compute

When sustained volume makes per-invocation pricing the expensive option, the compute swaps from Lambda to an always-on container — same API concept, different engine. Setting `"computeMode": "fargate"` in `cicd.json` switches the deployment model:

- The release artifact is a **container image in ECR**, tagged with the commit.
- Deploy registers a new **ECS task-definition revision** pinned to that image tag, updates the Fargate service, and waits for the rollout to stabilize — rolling back automatically if it doesn't.
- The API surfaces through an **HTTP API (API Gateway v2)** custom-domain mapping instead of REST API base-path mappings.

This is the "low-cost" tier you graduate to from the "zero-cost" tier: you start paying for capacity (vCPU-hours and memory) instead of invocations, which is a worse deal at low traffic and a much better one at high, steady traffic. Per-stage CPU and memory settings let dev run small while prod runs sized-to-load.

### When to switch Lambda → Fargate

Lambda bills per request and per GB-second of execution; Fargate bills per vCPU-hour and GB-hour whether requests arrive or not. At low or bursty traffic, Lambda wins decisively — idle costs nothing. As traffic becomes high and sustained, the same work costs less on an always-on container, and the crossover arrives sooner for compute-heavy methods. Because both sub-models present the same API surface, the switch is an infrastructure decision (a new compute stack in CloudFormation, a `computeMode` flip in `cicd.json`) — not an application rewrite.

### Supporting architecture (not sub-models)

A real API build-out is more than request/response endpoints, and the same pipeline deploys the rest of it with the same commit-versioned mechanics:

- **SNS-subscribed Lambdas** — event fan-out; subscriptions are re-pointed to the new commit's alias on each deploy.
- **SQS-triggered Lambdas** — queue workers with batch and concurrency controls; event source mappings follow the alias.
- **Standalone workers** — Lambdas with no managed trigger (scheduled jobs, manually invoked tools) that still get stage environment variables and commit versioning so `clean` won't orphan them.
- **Environment resolution** — variables resolve from CloudFormation exports (`!ImportValue`), Parameter Store (`!ParameterStore`), or the local environment (`!SetEnv`), with stage overrides on top of globals.
- **Throttling and concurrency** — API Gateway rate/burst limits at the global, stage, or API level; per-function reserved concurrency (including `0` to deliberately throttle a function).

These round out a complete architecture in one deployment pipeline, but they're deployment features — the exposure sub-models above are about how the API meets its consumers.

## The WWW Model

The WWW model is a static site on **S3 + CloudFront**, with a deployment layout built entirely around instant rollback.

Per stage, the S3 bucket holds:

```
{stage}/{commit}/        ← "dark" build, uploaded on every deploy; the rollback source
{stage}/live/            ← what CloudFront actually serves
{stage}/.cicd-live.json  ← {commit, deployedAt} marker (outside live/, never served)
```

The CloudFront origin path is **fixed at `/{stage}/live`, set once in CloudFormation, and never touched by this tool** — re-pointing the distribution per deploy proved fragile in practice, so the moving parts are pure S3 operations:

- **Deploy** = upload the build to `{stage}/{commit}/` → sync it into `{stage}/live/` (copy-then-prune, so there's no empty-bucket window) → write the marker → invalidate the cache.
- **Rollback** = re-sync an existing `{stage}/{commit}/` into `live/`. No upload, no rebuild — a pure S3 pointer flip that completes in seconds. The only prerequisite is that the target commit's dark build hasn't been pruned by `clean`.

Non-production stages can be kept out of search engines with `noindexStages`, which injects a `Disallow: /` robots.txt into the deployed build for those stages.

Note the symmetry with API sub-model 2: the www CloudFront distribution is the natural host for web-path-exposed APIs. A complete product can present one domain — `www.domain.com` for the site, `www.domain.com/api/*` for its API — with both halves deployed and rolled back by this tool, commit by commit.

## Putting It Together

A typical product built on these models looks like:

- **One infrastructure repo** — CloudFormation stacks that create the durable resources (APIs, functions, buckets, distributions, topics, queues, clusters) and export their identifiers.
- **One www repo** — the static site, deployed with the WWW model.
- **One or more api repos** — each a set of crud clusters plus supporting workers, deployed with the API model, importing what they need from the infrastructure exports.

Everything starts on the zero-cost tier: Lambda-backed APIs, S3/CloudFront for the site, usage-priced messaging. Stages give you dev/staging/prod isolation from day one; commit-keyed artifacts give you instant rollback from day one. As individual APIs earn sustained traffic, each can graduate to Fargate independently — the surface its consumers see never changes, and the deployment workflow (`deploy`, `rollback`, `info`, `clean`) never changes either.
