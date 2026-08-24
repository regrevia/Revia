# Runtime Distribution

Revia executable archives are published as GitHub Release assets, not committed
to this repository. [checksums.txt](checksums.txt) pins both the archive and the
extracted executable accepted by the launcher. Cached binaries are rechecked
before every run.

The first preview asset is a closed-source, ad-hoc-signed `macOS arm64`
executable. It bundles its runtime and does not require Node.js on the user's
machine. It is not notarized and is not a production runtime.

Exact platform and bundled-runtime metadata is recorded in
[build-metadata.json](build-metadata.json). Node.js and bundled third-party
license notices are preserved in [NODE_LICENSE](NODE_LICENSE),
[PKG_LICENSE](PKG_LICENSE), and [PKG_FETCH_LICENSE](PKG_FETCH_LICENSE).
