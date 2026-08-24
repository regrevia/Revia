# Compatibility

## Release Asset Matrix

| Version | Target | Verified environment | Status |
|---|---|---|---|
| `0.1-preview.1` | macOS `arm64` | macOS 15 | Verified preview asset |
| `0.1-preview.1` | macOS `x86_64` | macOS 15 Intel | Verified preview asset |
| `0.1-preview.1` | Linux `arm64` | Ubuntu 24.04 | Verified preview asset |
| `0.1-preview.1` | Linux `x86_64` | Ubuntu 24.04 | Verified preview asset |
| `0.1-preview.1` | Windows `arm64` | Windows 11 | Verified preview asset |
| `0.1-preview.1` | Windows `x86_64` | Windows Server 2025 | Verified preview asset |

The verified row means the documented hello, diagnostic, and manifest paths
were exercised on the named environment. It is not a minimum-version claim or
production support SLA.

## Installation Properties

- Each binary bundles its runtime; Node.js is not required on the target host.
- The release archive is verified with a repository-pinned SHA-256 digest.
- The extracted executable is verified with a second SHA-256 digest.
- macOS executables are ad-hoc signed and not Apple-notarized. Linux and
  Windows executables are unsigned.
- The launcher uses a per-user cache and does not request administrator access.
- The initial download requires access to GitHub Releases.

Report unsupported platforms as an experience/proposal Issue rather than
building or redistributing compiler/runtime source from this repository.
