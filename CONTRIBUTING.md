# Contributing to `@abwaters/cicd`

Thanks for your interest in contributing! This is a small, focused tool for AWS CI/CD deployments. Contributions that improve correctness, documentation, or test coverage are very welcome.

## Local development

```bash
git clone https://github.com/abwaters/cicd.git
cd cicd
npm install
cp cicd.example.json cicd.json   # then edit
npm run build
npm test
```

Useful scripts:

- `npm run build` — compile TypeScript to `dist/`
- `npm run watch` — incremental compile
- `npm test` — run the Jest suite
- `npm run validate` — validate the local `cicd.json` against `cicd.schema.json`

## Adding tests

Tests live in `test/` and use Jest with `ts-jest`. Add a `*.test.ts` file next to the existing ones and follow their structure. Run `npm test` locally before pushing.

If your change touches `cicd.json` parsing, validation, or schema, add a test that covers both the success path and the failure path — see `test/semantic.test.ts` for examples.

## Commit conventions

This repo uses [Conventional Commits](https://www.conventionalcommits.org/). Common prefixes:

- `feat:` — new user-facing feature
- `fix:` — bug fix
- `refactor:` — internal change with no behavior diff
- `docs:` — documentation only
- `test:` — tests only
- `chore:` / `build:` — tooling, dependencies, repo hygiene

Examples from this repo's history:

```
feat: make info output compact by default, add --verbose for details
fix: truncate GitHub deployment description to 140 chars
build(deps): Bump @aws-sdk/client-ssm from 3.1045.0 to 3.1049.0
```

## Pull request checklist

Before opening a PR:

- [ ] `npm run build` succeeds with no warnings
- [ ] `npm test` is green
- [ ] If you changed the config shape, `cicd.schema.json` is updated and an example/test reflects it
- [ ] If you changed user-facing behavior, README and/or QUICKSTART are updated
- [ ] Commit message follows Conventional Commits

## Reporting bugs / requesting features

Open an issue using the provided templates in `.github/ISSUE_TEMPLATE/`. Include:

- The version (`cicd --version` or the `version` field in `package.json` you're running against)
- AWS region
- A redacted `cicd.json` snippet that reproduces the issue
- The exact command and the output

## Security

For vulnerabilities, please follow [SECURITY.md](SECURITY.md) — do not open a public issue.
