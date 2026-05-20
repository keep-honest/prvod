# Security Policy

## Supported Versions

Only the latest release on `main` receives security patches. This is a 0.x project; there is no backporting to prior releases.

| Branch | Supported |
|--------|-----------|
| `main` (latest) | Yes |
| All other branches/tags | No |

## Reporting a Vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Report all security issues through [GitHub Security Advisories](https://github.com/keep-honest/prvod/security/advisories/new). This keeps the details private until a fix is available.

### What to include

- A clear description of the vulnerability and its potential impact.
- Steps to reproduce or a proof-of-concept (minimal, non-destructive).
- The component affected (e.g., InputSanitizer, OutputValidator, API auth middleware).
- Any suggested mitigation or fix, if you have one.

### Response timeline

| Stage | Target |
|-------|--------|
| Acknowledge report | 48 hours |
| Provide assessment (severity, scope, plan) | 7 days |
| Patch critical vulnerabilities | 14 days |

If a fix requires more time, we will communicate the revised timeline in the advisory thread.

## Scope

### In scope

- **Prompt injection bypasses** -- circumventing the 7-layer defense-in-depth pipeline (InputSanitizer, XML boundary, canary tokens, schema validation, OutputValidator, credential/PII scanning, grounded clip validation).
- **Authentication or authorization bypasses** -- API key validation, one-time trial key lifecycle, GitHub App JWT/webhook HMAC-SHA256 verification, middleware tier enforcement.
- **Credential or API key exposure** -- secrets appearing in logs, API responses, error messages, or LLM-generated content.
- **PII or credential leakage through LLM outputs** -- sensitive data surviving the OutputValidator and reaching video/TTS prompts.
- **Unauthorized access** -- reading, modifying, or deleting jobs, videos, or keys belonging to another user or installation.

### Out of scope

- Vulnerabilities in third-party providers (fal.ai, kie.ai, Runware, Google TTS, Anthropic). Report those to the respective provider.
- Denial-of-service from excessively large pull requests.
- Issues that require physical access to the server.
- Social engineering attacks.
- Vulnerabilities in upstream dependencies. Report those to the dependency maintainer.

## Disclosure

We follow coordinated disclosure. Once a fix is released, we will publish the advisory with full details and credit the reporter (unless anonymity is requested).

## License

This project is licensed under the [Elastic License 2.0 (ELv2)](LICENSE).
