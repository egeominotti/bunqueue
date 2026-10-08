# Security Policy

## Reporting a vulnerability

**Do not open a public issue, discussion or pull request for a security problem.**

Report it privately through one of these channels:

1. **GitHub Private Vulnerability Reporting** (preferred):
   [open a draft advisory](https://github.com/egeominotti/bunqueue/security/advisories/new).
2. **Email**: [founder@bunqueue.dev](mailto:founder@bunqueue.dev) with the subject
   `[SECURITY] bunqueue: <short summary>`.

Include as much of the following as you can:

- affected version(s), deployment mode (embedded, TCP server, PostgreSQL multi-broker)
  and the relevant configuration (redact secrets);
- the component involved (TCP protocol, HTTP/WebSocket/SSE API, MCP server, CLI,
  persistence, S3 backup, cloud agent, an official SDK);
- reproduction steps or a proof of concept;
- the impact you observed or expect (confidentiality, integrity, availability).

## What to expect

| Step                                         | Target                     |
| -------------------------------------------- | -------------------------- |
| Acknowledgement of the report                | 3 business days            |
| Initial assessment and severity (CVSS v4)    | 7 business days            |
| Fix for Critical / High severity             | 30 days from confirmation  |
| Fix for Medium / Low severity                | Next scheduled release     |
| Public advisory (GHSA, CVE when applicable)  | When a fixed release ships |

We keep you informed during the process, agree on a disclosure date with you, and
credit you in the advisory unless you prefer to stay anonymous. Please give us a
reasonable time to release a fix before any public disclosure (90 days at most).

## Supported versions

Security fixes are released for:

| Version                          | Supported                                  |
| -------------------------------- | ------------------------------------------ |
| Latest minor (currently `2.9.x`) | Yes                                        |
| Previous minor                   | Critical and High fixes for 3 months after the next minor ships |
| Older releases                   | No: upgrade to a supported version          |

The same policy applies to the official SDKs under `sdk/`, each against its own
latest published minor. Support windows for previous major versions are defined in
[VERSIONING.md](VERSIONING.md#support-windows).

## Scope

In scope: the code in this repository and the artifacts published from it (the
`bunqueue` npm package, the standalone binaries attached to GitHub Releases, the
`egeominotti/bunqueue` container images and the official SDK packages).

Out of scope:

- deployments that disable authentication (no `AUTH_TOKENS`) while exposing the TCP
  or HTTP ports to an untrusted network: see the hardening guide below;
- denial of service that needs valid credentials and only exhausts limits the
  operator configured;
- vulnerabilities in third-party dependencies with no demonstrated impact on bunqueue
  (report those upstream; we still welcome a heads-up);
- findings from automated scanners without a working impact.

## Hardening checklist for production

- Set `AUTH_TOKENS` to long random values and keep them out of source control. Without
  tokens every TCP and HTTP operation, including the `/gc` and `/heapstats` debug
  endpoints, is unauthenticated.
- Enable TLS with `TLS_CERT_FILE` and `TLS_KEY_FILE`, or terminate TLS in front of the
  server on a private network.
- Bind `HOST` to a private interface; never expose ports `6789`/`6790` directly to the
  internet.
- Set `CORS_ALLOW_ORIGIN` only to the origins that need the HTTP API from a browser;
  avoid `*`. When it is unset, the server sends no usable CORS origin.
- Set `METRICS_AUTH=true` when `/metrics` is reachable outside the monitoring network.
- Protect the SQLite data directory and S3 backup bucket: they contain job payloads.
- Pin a released version and verify artifacts before deploying. Release archives
  and container images (from the first release after 2.9.12) carry signed build
  provenance, and images a CycloneDX SBOM:
  `gh attestation verify <archive> --repo egeominotti/bunqueue` or
  `gh attestation verify oci://ghcr.io/egeominotti/bunqueue:<version> --repo egeominotti/bunqueue`.
