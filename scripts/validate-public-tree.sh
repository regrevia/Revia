#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT"

VERSION=$(sed -n '1p' VERSION)
test "$VERSION" = "0.1-preview.1"
grep -Fq 'Agent-native executable language for the AI-native era.' README.md
grep -Fq '面向 AI 原生时代的 Agent 原生可执行语言。' README.zh-CN.md
grep -Fq 'Closed-source technical preview' README.md
grep -Fq '闭源技术预览版' README.zh-CN.md
grep -Fq '## Run The Full Loop' README.md
grep -Fq '## 运行完整流程' README.zh-CN.md
grep -Fq 'Revia translator from' README.md
grep -Fq 'Revia 翻译器根据' README.zh-CN.md
grep -Fq '## Explore' README.md
grep -Fq '## 文档与入口' README.zh-CN.md
grep -Fq 'Quickstart / 快速开始' QUICKSTART.md
grep -Fq 'Reinstall Or Uninstall / 重装或卸载' QUICKSTART.md
grep -Fq 'Re Language / Re 语言' docs/language.md
grep -Fq 'result<list<text.utf8>, process.args_error>' docs/language-reference.md
grep -Fq 'result<text.utf8, fs.read_error>' docs/language-reference.md
grep -Fq 'Notice / 声明' NOTICE.md
grep -Fq 'GitHub Private Vulnerability Reporting is enabled' SECURITY.md
grep -Fq 'WP-299' docs/server-conformance.md
grep -Fq 'Stable V1.0' docs/stable-release-gate.md
grep -Fq 'Revia Release Candidate Developer Evaluation License 1.0' LICENSE-RC.md
grep -Fq 'not legal advice' docs/rc1-license-and-limitations.md
grep -Fq 'measured-emulated' docs/cross-platform-evidence.md
grep -Fq 'revia.public-rc-export@1.0.0' docs/rc1-sealed-export-contract.md
sh -n bin/revia
sh -n scripts/verify-rc1-export.sh
grep -Fq '*.re text eol=lf' .gitattributes
grep -Fq 'windows-arm64' bin/revia.ps1
grep -Fq 'windows-x64' bin/revia.ps1
for target in darwin-arm64 darwin-x64 linux-arm64 linux-x64 windows-arm64 windows-x64; do
  grep -Fq "target: $target" .github/workflows/release-smoke.yml
done
grep -Fq 'permissions: {}' .github/workflows/release-gate.yml
grep -Fq 'contents: read' .github/workflows/release-gate.yml
grep -Fq 'contents: write' .github/workflows/release-gate.yml
grep -Fq 'persist-credentials: false' .github/workflows/release-gate.yml
grep -Fq 'without repository token' .github/workflows/release-gate.yml
grep -Fq 'post-publish-smoke:' .github/workflows/release-gate.yml
grep -Fq 'permissions: {}' .github/workflows/rc1-release-gate.yml
grep -Fq 'persist-credentials: false' .github/workflows/rc1-release-gate.yml
grep -Fq 'without repository credentials' .github/workflows/rc1-release-gate.yml
grep -Fq 'runs-on: macos-15' .github/workflows/rc1-release-gate.yml

for path in README.md README.zh-CN.md QUICKSTART.md RELEASE_NOTES.md LICENSE NOTICE.md VERSION \
  runtime/checksums.txt feedback/FEEDBACK_TEMPLATE.md docs/language.md \
  runtime/build-metadata.json runtime/NODE_LICENSE runtime/PKG_LICENSE \
  runtime/PKG_FETCH_LICENSE docs/protocol.md bin/revia.ps1 .gitattributes \
  scripts/test-compact-determinism.sh scripts/test-compact-determinism.ps1 \
  scripts/test-compact-determinism-contract.sh \
  scripts/test-json-contract.sh \
  docs/agent-workflow.md docs/compatibility.md examples/agent-review/main.re \
  examples/agent-review/README.md projects/README.md \
  projects/_template/main.re projects/_template/README.md \
  projects/_template/HANDOFF.md docs/feedback-loop.md \
  feedback/agent-discovered-issues/README.md \
  feedback/agent-discovered-issues/_TEMPLATE.md \
  docs/architecture.md docs/architecture.zh-CN.md docs/evidence.md \
  docs/evolution.md docs/development-status.md docs/language-reference.md docs/release-policy.md \
  docs/server-conformance.md docs/stable-release-gate.md docs/execution-contract.md \
  LICENSE-RC.md NOTICE-RC.md docs/rc1-license-and-limitations.md \
  docs/cross-platform-evidence.md scripts/verify-rc1-export.sh \
  docs/rc1-sealed-export-contract.md \
  .github/workflows/rc1-release-gate.yml \
  docs/execution-contract.zh-CN.md \
  examples/agent-handoff-review/main.re examples/agent-handoff-review/README.md \
  examples/agent-workflow-brief.re examples/agent-args-policy.re \
  examples/agent-file-report.re examples/agent-file-report.txt; do
  test -f "$path"
done

for document in README.zh-CN.md QUICKSTART.md CONTRIBUTING.md RELEASE_NOTES.md \
  SECURITY.md NOTICE.md docs/*.md examples/README.md \
  examples/agent-review/README.md feedback/FEEDBACK_TEMPLATE.md \
  projects/README.md projects/_template/README.md \
  projects/_template/HANDOFF.md runtime/README.md docs/feedback-loop.md \
  feedback/agent-discovered-issues/README.md \
  feedback/agent-discovered-issues/_TEMPLATE.md; do
  LC_ALL=C grep -Eq '[^ -~]' "$document"
done

for issue in feedback/agent-discovered-issues/*.md; do
  case "$(basename "$issue")" in
    README.md|_TEMPLATE.md) continue ;;
  esac
  [ -e "$issue" ] || continue
  basename "$issue" | grep -Eq '^[0-9]{4}-[0-9]{2}-[0-9]{2}-[a-z0-9-]+\.md$'
  for heading in '## Identity / 标识' '## Lifecycle / 生命周期' \
    '## Observation / 现象' '## Minimal reproduction / 最小复现' \
    '## Expected vs actual / 预期与实际' '## Resolution / 处理结果' \
    '## Next action / 下一步'; do
    grep -Fq "$heading" "$issue"
  done
done

FORBIDDEN=$(find . -path './.git' -prune -o -type f \
  \( -name '*.js' -o -name '*.mjs' -o -name '*.cjs' -o -name '*.ts' \
     -o -name '*.tsx' -o -name '*.c' -o -name '*.cc' -o -name '*.cpp' \
     -o -name '*.rs' -o -name '*.go' -o -name '*.py' -o -name '*.map' \) \
  -print)
if [ -n "$FORBIDDEN" ]; then
  printf '%s\n' 'Forbidden implementation/source-map files:' "$FORBIDDEN" >&2
  exit 1
fi

if grep -R -I -n -E '/Users/[^/]+/|BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY|github_pat_|ghp_[A-Za-z0-9]|sk-[A-Za-z0-9_-]{20,}|V1-DESIGN|RELAY_STATE|COORDINATOR_GUIDANCE' \
  --exclude-dir=.git --exclude=validate-public-tree.sh --exclude=verify-rc1-export.sh .; then
  printf '%s\n' 'Private path, credential-like value, or internal governance marker found.' >&2
  exit 1
fi

for target in darwin-arm64 darwin-x64 linux-arm64 linux-x64 windows-arm64 windows-x64; do
  case "$target" in
    windows-*) extension=zip ;;
    *) extension=tar.gz ;;
  esac
  asset="revia-$VERSION-$target.$extension"
  archive_checksum=$(awk -v name="$asset" '$2 == name { print $1 }' runtime/checksums.txt)
  binary_checksum=$(awk -v name="${asset%.$extension}" '$2 == name { print $1 }' runtime/checksums.txt)
  printf '%s' "$archive_checksum" | grep -Eq '^[0-9a-f]{64}$'
  printf '%s' "$binary_checksum" | grep -Eq '^[0-9a-f]{64}$'
done

for report in feedback/submissions/*.md; do
  [ -e "$report" ] || continue
  basename "$report" | grep -Eq '^[0-9]{4}-[0-9]{2}-[0-9]{2}-[a-z0-9-]+\.md$'
  if grep -Fq '## Curated Public Feedback / 已整理公开反馈' "$report"; then
    for field in 'Platform / 平台' 'Date / 日期' 'Public agent / 公开 Agent' \
      'Source / 来源' 'Evidence status / 证据状态' \
      'Classification / 分类' 'Next action / 下一步'; do
      grep -Fq "$field" "$report"
    done
  else
    grep -Fq '使用环境' "$report"
    for heading in '## Use Environment' '## Installation Method' \
      '## `.re` Project Used' '## Successful Steps' '## Failed Steps' \
      '## Error Information' '## Generated Artifacts' \
      '## Language Suggestions' '## Would You Continue Using Revia?'; do
      grep -Fq "$heading" "$report"
    done
  fi
done

for project in projects/*; do
  [ -d "$project" ] || continue
  [ "$(basename "$project")" = '_template' ] && continue
  basename "$project" | grep -Eq '^[0-9]{4}-[0-9]{2}-[0-9]{2}-[a-z0-9]+-[a-z0-9-]+$'
  test -f "$project/main.re"
  test -f "$project/README.md"
  test -f "$project/HANDOFF.md"
  grep -Fq '项目' "$project/README.md"
  grep -Fq '接续' "$project/HANDOFF.md"
done

sh scripts/test-json-contract.sh

printf '%s\n' 'public tree validation passed'
