# Versioning: Semver vs Commit

A companion to [Infrastructure Models](infrastructure-models.md). That document explains *what* this tool deploys; this one explains why everything it deploys is versioned by **git commit** rather than by **semantic version** — and why that isn't a rejection of semver, but a recognition that semver answers a different question, and answers it with humans in the loop.

## Two different questions

Every versioning scheme exists to answer a question. The two schemes answer different ones:

- **Semver answers: "what does this change mean for the code that depends on mine?"** It versions a *contract*. The major/minor/patch triplet is a compatibility promise from a producer to consumers who resolve the artifact by version range.

- **A commit answers: "exactly what is running, and can I get back to what ran before?"** It versions a *state*. The hash is the identity of a precise source tree — automatic, unique, immutable, and traceable to everything that produced it.

The deeper difference: one is interpretive and one is deterministic. A semver is a *judgment* someone made about a change. A commit is a *fact* about it. The opinion of this tool, in one line: **semver is for what's consumed; commits are for what's deployed.**

## What semver is good at

Semver is deeply meaningful, and it's the right scheme for artifacts consumed as *dependencies* — libraries, packages, CLI tools — where many consumers, on their own schedules, resolve your artifact through version ranges (`^2.3.0`) and need a machine-readable signal about compatibility. It helps tremendously in dependency management. A major bump warns of breakage; a patch promises safety.

But be precise about what that signal is: **it tells you the intent of the author. It does not guarantee it.** A patch release can break you; a major bump can be a no-op for your usage. Semver communicates a promise; the hash is the only thing that identifies what you actually got.

This repo practices what it preaches: the `cicd` tool itself is published to npm via semantic-release, with versions derived automatically from conventional commit messages. It's consumed as a dependency, so it gets a semver.

## The human surface

Semver's semantics require human oversight. Someone has to decide that a change is a *chore* or a *fix* or a *feature*; someone has to judge whether it's breaking. Semantic-release systems automate the bump arithmetic cleverly — but the judgment doesn't disappear, it moves upstream into commit classification, performed by every contributor, on every commit, forever.

In tightly controlled domains, this works well. At scale, it starts to fall apart. The more engineers — the more participants of any kind — the more ways the model breaks: people come at a problem from different perspectives, operate in different mental states, work under different levels of pressure. Any sufficiently complicated surface has holes, and no tool or convention can be built to cover all the ways real people will come at it.

This is a tough concept for engineers to grasp, because the fix looks easy: *don't do the things that cause it to break.* That instinct is exactly the tell. A release model that depends on every participant classifying every change correctly, consistently, under pressure, is not a model — it's a hope. The real world doesn't grade on intentions.

## Keep the high-pressure path reductive

Deployment is the high-pressure, high-cost segment of the pipeline. When it runs, it changes production; when it matters most — the rollback during an incident — the people running it are at their most stressed and least careful. The design principle that follows: **keep that segment as simple and as reductive as possible.**

The commit hash is the reductive choice. It has no room for interpretation. It can't be missed the way a manual tag can. You can't argue over it the way you can argue over a patch-versus-minor increment. It requires no decision, no ceremony, no coordination — it exists, complete and unambiguous, the moment the code does. Releases keyed on it are **fully deterministic**: the same input always names the same artifact, no matter who runs the pipeline or what kind of day they're having.

Everything in the deployment machinery follows from that choice:

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

So if you choose semver because you like the elegance of it — do. It earns its keep in dependency management, and it tells your consumers what you *meant* by a release. Just keep it out of the high-pressure path. Deployments key on the commit, because the hash is the one identifier with no room for interpretation — the only one that can never disagree with reality.
