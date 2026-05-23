# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- OSS readiness: MIT `LICENSE`, `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, issue and PR templates, and this changelog.
- `cicd.example.json` as a starting point for new users.

### Changed
- `package.json` `license` field switched from `ISC` to `MIT`.

### Removed
- The committed real `cicd.json` (now ignored — copy `cicd.example.json` to get started).
- Internal `plans/` working notes.
- Dead `src/test-ps.js` script.

## [1.0.0] — 2026-05-23

Initial public release. The tool already shipped prior versions internally; this is the first release after OSS readiness work.

Highlights of what's in `1.0.0`:

- Deploy, rollback, info, clean, validate, restart, env, and invalidate subcommands
- Lambda + API Gateway + SNS + SQS + Workers deployment support
- Web (S3 + CloudFront) deployment with `invalidate` subcommand
- Fargate compute mode (`computeMode: "fargate"`) alongside the default Lambda mode
- Git-commit-based versioning of Lambda versions, aliases, and API Gateway stages
- Stage-specific and global throttle and environment overrides
- GitHub Deployments integration for rollback history
- Twilio messaging service integration

Going forward, releases will be managed via [Changesets](https://github.com/changesets/changesets) (planned, see Phase 5 of the OSS readiness work).
