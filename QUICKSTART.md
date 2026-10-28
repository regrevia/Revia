# Quickstart / 快速开始

## Source development / 源码开发

The repository publishes its source under [MPL-2.0](LICENSE). The source
development workflow is independent from the historical preview and RC binary
assets, which retain [LICENSE-PREVIEW-0.1.md](LICENSE-PREVIEW-0.1.md) and
[LICENSE-RC.md](LICENSE-RC.md), respectively.

```bash
git clone https://github.com/regrevia/Revia.git
cd Revia
npm test
npm run re -- check examples/hello.re
npm run re -- run examples/hello.re
```

The Node reference toolchain requires Node.js 22 or newer and uses only the
standard library. No credentials or network service are required for the
source test suite.

The native toolchain is in `native/`:

```bash
cargo test --workspace --offline
cargo fmt --all -- --check
cargo clippy --workspace --offline -- -D warnings
```

## Historical release assets / 历史发行资产

The existing `v1.0.0-rc.1` binary release is a historical evaluation
candidate. It remains governed by [LICENSE-RC.md](LICENSE-RC.md), not by the
source license. Verify its exact checksums and target evidence before use.
The historical preview line remains governed by
[LICENSE-PREVIEW-0.1.md](LICENSE-PREVIEW-0.1.md).

The historical RC is not a production backend and does not establish complete
language output determinism, cross-platform equivalence, full protocol
interoperability, or Stable V1.0.

## Repository hygiene / 仓库卫生

Do not commit credentials, personal data, private messages, local absolute
paths, generated archives, build directories, source maps, or private
infrastructure metadata. Keep temporary probes under ignored `scratch/`.

Before opening a pull request:

```bash
git diff --check
gitleaks dir --redact .
```

Security-sensitive reports must use the repository's private security channel.
