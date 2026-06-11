# Versioning: Semver vs Commit

A companion to [Infrastructure Models](infrastructure-models.md). That document explains *what* this tool deploys; this one explains why everything it deploys is versioned by **git commit** rather than by **semantic version** — and why that isn't a rejection of semver, but a recognition that semver answers a different question.

## Two different questions

Every versioning scheme exists to answer a question. The two schemes answer different ones:

- **Semver answers: "what does this change mean for the code that depends on mine?"** It versions a *contract*. The major/minor/patch triplet is a compatibility promise from a producer to consumers who resolve the artifact by version range.

- **A commit answers: "exactly what is running, and can I get back to what ran before?"** It versions a *state*. The hash is the identity of a precise source tree — automatic, unique, immutable, and traceable to everything that produced it.

Confusing the two is how teams end up with version-bump ceremony on services nobody consumes by range, or with production incidents where nobody can say which code is actually live. The opinion of this tool: **semver is for what's consumed; commits are for what's deployed.**

## What semver is good at

Semver is the right scheme for artifacts consumed as *dependencies* — libraries, packages, CLI tools — where many consumers, on their own schedules, resolve your artifact through version ranges (`^2.3.0`) and need a machine-readable signal about compatibility. The version number carries intent: a major bump warns of breakage, a patch promises safety. That signal is the whole point, and nothing about a commit hash provides it.

This repo practices what it preaches: the `cicd` tool itself is published to npm via semantic-release, with versions derived automatically from conventional commit messages. It's consumed as a dependency, so it gets a semver.

## Why deployments are different

A deployed application is not consumed by version range. An environment — dev, staging, prod — runs exactly one version at a time, and nobody `npm install`s your production API. The questions that matter are operational: what is live, what was live before, how do I get back. Commits answer those questions better than semver can, for several reinforcing reasons.

**Identity, not intent.** A commit hash requires no human judgment. There is no "what do we bump?" debate, no version-bump commit, no race between two branches claiming the same number, no tag that someone forgot to push. Every commit is *already* a complete, unambiguous release identifier the moment it exists.

**Promotion, not publication.** A release moves through stages: deployed to dev, promoted to staging, promoted to prod. It's the *same artifact* at every step, and its identity must not change as it moves. Commit-keyed artifacts promote without renaming. Semver fits awkwardly here — either every promotion mints a new version (so the "same" release has three names), or the version stays fixed and tells you nothing about which build of it you're running.

**Total traceability.** The commit *is* the source tree. From the hash on a Lambda alias you get the exact code, the diff against what ran before, the blame, the CI run that built it, and the GitHub deployment record that shipped it — with no indirection. A version tag is a pointer that can drift, be re-pointed, or lie; a hash can't.

**Deploy/rollback symmetry.** Because every release artifact is keyed by commit and prior artifacts are retained, rollback is just deploy pointed at an earlier commit — no rebuild, no "which artifact was 2.3.1 again?", no archaeology. This symmetry is the foundation of the quick-rollback goal described in [Infrastructure Models](infrastructure-models.md).

**Uniformity across artifact kinds.** One scheme versions everything the tool touches, identically:

| Artifact | Versioned as |
|---|---|
| Lambda version & alias | `{app}-{commit}` |
| API Gateway stage variable | `Commit: {app}-{commit}` |
| S3 web build prefix | `{stage}/{commit}/` |
| ECR image / ECS task definition | image tagged `{commit}` |

The `info` command can reconstruct what's live in any stage purely from these markers, because they all speak the same language.

## What you give up, and how the tool compensates

Commit hashes are honest but illegible. They carry no ordering, no magnitude, no meaning a human can read at a glance. The tool compensates rather than pretends otherwise:

- **Ordering and history** come from the **GitHub Deployments ledger** — every deploy and rollback is recorded with its environment, status, and timestamp, so "what came before what" is a query, not a guess.
- **Human meaning** comes from the deployment **description**, which defaults to the commit's subject line. If you write conventional commits, every entry in the ledger reads like a changelog for free (`fix: cache stampede on order lookup`), and can be overridden per deploy (`--description="hotfix: cache fix"`).
- **Current state** comes from `cicd info`, which reads the commit markers off the live infrastructure itself — the answer comes from what's actually running, not from a spreadsheet.

What about the compatibility signal semver provides? For a deployed application, the compatibility contract doesn't live in a version number — it lives at the API surface, and it's managed structurally: stages isolate environments, paths and prefixes isolate API generations. A version number stapled to a deployment wouldn't enforce any of that; it would just decorate it.

## Both schemes, one repo

The two schemes are not rivals; they version different things, and a single repo often needs both. This one does:

- The **tool as a package** is semver'd — semantic-release reads conventional commits and publishes to npm with an automated, meaningful version number, because downstream `package.json` files consume it by range.
- The **deployments it performs** are commit-keyed, because environments consume exact states, not ranges.

Conventional commits are the bridge between the worlds: the same commit message that tells semantic-release *what to bump* tells the deployment ledger *what shipped*. Write the message once; both versioning schemes get their meaning from it.

The rule of thumb, restated: **if something is consumed by others as a dependency, give it a semver. If something is deployed into an environment, key it by commit.** When humans need a memorable name for a milestone, tag it — tags and hashes coexist happily. But the deployment machinery keys on the hash, because the hash is the one identifier that can never disagree with reality.
