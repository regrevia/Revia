# Runtime Distribution

Revia executable archives are published as GitHub Release assets, not committed
to this repository. [checksums.txt](checksums.txt) pins both the archive and the
extracted executable accepted by the launcher. Cached binaries are rechecked
before every run.

The current preview assets are closed-source executables for macOS, Linux, and
Windows on `arm64` and `x86_64`. They bundle their runtime and do not require
Node.js on the user's machine. macOS assets are ad-hoc signed and not
Apple-notarized; Linux and Windows assets are unsigned. None is a production
runtime.

Exact platform and bundled-runtime metadata is recorded in
[build-metadata.json](build-metadata.json). Node.js and bundled third-party
license notices are preserved in [NODE_LICENSE](NODE_LICENSE),
[PKG_LICENSE](PKG_LICENSE), and [PKG_FETCH_LICENSE](PKG_FETCH_LICENSE).
