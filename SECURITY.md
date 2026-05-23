# Security Policy

## Supported versions

Only the latest published `1.x` release is supported with security updates.

| Version | Supported |
|---------|-----------|
| `1.x`   | ✅        |
| `< 1.0` | ❌        |

## Scope

`@abwaters/cicd` is a command-line tool that runs against the operator's own AWS account using credentials the operator provides. Within that scope, the security-sensitive surfaces are:

- **AWS credential handling** — the tool reads credentials from the standard AWS SDK chain (env vars, shared credentials file, role) and does not persist or log them.
- **Configuration parsing** — `cicd.json` is loaded from disk and validated against `cicd.schema.json`. A malicious config could in principle cause the tool to make unintended AWS API calls; the operator is expected to trust their own config file.
- **Parameter Store and CloudFormation export resolution** — values resolved via `!ParameterStore` and `!ImportValue` are read at deploy time and pushed to Lambda environment variables. The tool does not log these values; the operator is responsible for the IAM policy that grants read access.
- **Third-party HTTP** — GitHub Deployments API (rollback history) and Twilio (optional messaging integration).

Out of scope: anything inside the user's own Lambda code, AWS account misconfigurations, or compromised AWS credentials.

## Reporting a vulnerability

**Please do not open a public GitHub issue for security reports.**

Email **bryanw@abwaters.com** with:

- A description of the vulnerability and its impact
- Steps to reproduce or a proof of concept
- The version (or commit) of `@abwaters/cicd` affected
- Your name / handle if you'd like credit

You should receive an acknowledgement within 5 business days. We'll work with you on a disclosure timeline appropriate to the severity.
