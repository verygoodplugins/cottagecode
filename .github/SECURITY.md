# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability, please **do not** open a public issue.

Instead, report it privately via
[GitHub Security Advisories](https://github.com/verygoodplugins/cottagecode/security/advisories/new).
We aim to respond within 3 business days.

For urgent issues you may also email
[support@verygoodplugins.com](mailto:support@verygoodplugins.com).

## Supported Versions

The latest release on the default branch receives security updates. Older
versions may be patched on a case-by-case basis.

## Disclosure Policy

We follow coordinated disclosure: we'll work with you on a fix and credit you
in the release notes if you wish.

## Notes for this project

CottageCode is a local viewer. It does not write back to agent runners. Pause /
wake / shut down are simulator-only. Treat any sqlite path you point at with
`AGENT_DB_PATH` as sensitive machine-local data and do not paste it into issues.
