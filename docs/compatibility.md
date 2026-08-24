# Compatibility

## Release Asset Matrix

| Version | Platform | Architecture | Minimum OS | Status |
|---|---|---|---|---|
| `0.1-preview` | macOS | Apple silicon (`arm64`) | macOS 13.5 | Verified preview asset |
| `0.1-preview` | macOS | Intel (`x86_64`) | - | Not published |
| `0.1-preview` | Linux | `x86_64` / `arm64` | - | Not published |
| `0.1-preview` | Windows | `x86_64` / `arm64` | - | Not published |

The verified row means the documented hello, diagnostic, and manifest paths
were exercised on the build platform. It is not a production support SLA.

## Installation Properties

- The binary bundles its runtime; Node.js is not required on the target Mac.
- The release archive is verified with a repository-pinned SHA-256 digest.
- The executable is ad-hoc signed and not Apple-notarized.
- The launcher uses a per-user cache and does not request administrator access.
- The initial download requires access to GitHub Releases.

Report unsupported platforms as an experience/proposal Issue rather than
building or redistributing compiler/runtime source from this repository.
