# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- OSS readiness: MIT `LICENSE`, `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, issue and PR templates, and this changelog.
- `cicd.example.json` as a starting point for new users.
- Plugin architecture for non-AWS-native integrations: `CICDPlugin` interface, `loadPlugins()` loader, `runPlugins()` dispatcher, top-level `plugins: string[]` in `cicd.json`, and runtime JSON-Schema merging of plugin-contributed `stages[].<key>` fragments. See `src/shared/plugin.ts`.
- New reference plugin package `@abwaters/cicd-plugin-twilio` (in `plugins/twilio/`) — Twilio webhook updates are now opt-in via this plugin.

### Changed
- `package.json` `license` field switched from `ISC` to `MIT`.
- Twilio support extracted from core into the `@abwaters/cicd-plugin-twilio` plugin. Stage configs that still have `stages[].twilio` but no `"plugins"` array now fail validation with a targeted hint pointing at the plugin install command.
- `resolveScope()` no longer hardcodes Twilio; the `--no-<pluginName>` flag is derived from each loaded plugin's name (or its declared `scopeFlag`).
- `printDeploymentSummary()` accepts `pluginResults: PluginResult[]` instead of a hardcoded `twilio` field; plugins fully own their rendering.

### Removed
- The committed real `cicd.json` (now ignored — copy `cicd.example.json` to get started).
- Internal `plans/` working notes.
- Dead `src/test-ps.js` script.
- `src/shared/twilio.ts` wrapper and `processTwilio()` from `src/shared/cicd.ts` — both moved into the plugin.
- `twilio` npm dependency from core `package.json`.

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
