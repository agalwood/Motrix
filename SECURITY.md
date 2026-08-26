# Security Policy

English | [简体中文](SECURITY.zh-CN.md)

## Supported Versions

Motrix provides security fixes for the latest published Motrix Turbo v2 release. Older v2 prereleases and the frozen legacy v1 line are not routinely supported; users should reproduce an issue on the latest release before reporting it when possible.

| Version | Supported |
| --- | --- |
| Latest published Motrix Turbo v2 release | Yes |
| Older Motrix Turbo v2 prereleases | No |
| Legacy Motrix v1 releases | No |

## Reporting a Vulnerability

Do not open a public issue, discussion, or pull request for a suspected vulnerability.

Report it privately through [GitHub's private vulnerability reporting](https://github.com/agalwood/Motrix/security/advisories/new). Include as much of the following information as possible:

- the affected Motrix version, runtime, operating system, and architecture;
- the affected component and security impact;
- the smallest reliable reproduction or proof of concept;
- relevant logs or screenshots with credentials, tokens, private URLs, and personal paths removed; and
- any known mitigations or suggested fixes.

The maintainers will review the report, keep communication within the private advisory, and coordinate remediation and disclosure according to the severity and available maintainer capacity. Please keep vulnerability details confidential until a fix or advisory is published, or disclosure is otherwise agreed upon.

## Scope

This policy covers the Motrix desktop and server applications, the native messaging host, official release artifacts and container images, and first-party code in this repository.

Report vulnerabilities in third-party plugins or services to their maintainers unless the issue also demonstrates a vulnerability in Motrix's sandbox, permission model, update verification, or host integration. General bugs and support requests belong in the [public issue forms](https://github.com/agalwood/Motrix/issues/new/choose) or [GitHub Discussions](https://github.com/agalwood/Motrix/discussions).
