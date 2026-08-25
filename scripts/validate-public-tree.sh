#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT"

VERSION=$(sed -n '1p' VERSION)
test "$VERSION" = "0.1-preview.1"
grep -Fq 'Agent-native executable language for the AI-native era.' README.md
grep -Fq '面向 AI 原生时代的 Agent 原生可执行语言。' README.zh-CN.md
grep -Fq '## Run The Full Loop' README.md
grep -Fq '## 运行完整流程' README.zh-CN.md
grep -Fq 'Revia translator from' README.md
grep -Fq 'Revia 翻译器根据' README.zh-CN.md
grep -Fq '## Explore' README.md
grep -Fq '## 文档与入口' README.zh-CN.md
grep -Fq 'Quickstart / 快速开始' QUICKSTART.md
grep -Fq 'Re Language / Re 语言' docs/language.md
grep -Fq 'Notice / 声明' NOTICE.md
sh -n bin/revia
grep -Fq '*.re text eol=lf' .gitattributes
grep -Fq 'windows-arm64' bin/revia.ps1
grep -Fq 'windows-x64' bin/revia.ps1
for target in darwin-arm64 darwin-x64 linux-arm64 linux-x64 windows-arm64 windows-x64; do
  grep -Fq "target: $target" .github/workflows/release-smoke.yml
done

for path in README.md README.zh-CN.md QUICKSTART.md RELEASE_NOTES.md LICENSE NOTICE.md VERSION \
  runtime/checksums.txt feedback/FEEDBACK_TEMPLATE.md docs/language.md \
  runtime/build-metadata.json runtime/NODE_LICENSE runtime/PKG_LICENSE \
  runtime/PKG_FETCH_LICENSE docs/protocol.md bin/revia.ps1 .gitattributes \
  docs/agent-workflow.md docs/compatibility.md examples/agent-review/main.re \
  examples/agent-review/README.md projects/README.md \
  projects/_template/main.re projects/_template/README.md \
  projects/_template/HANDOFF.md docs/feedback-loop.md \
  feedback/agent-discovered-issues/README.md \
  feedback/agent-discovered-issues/_TEMPLATE.md; do
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
  --exclude-dir=.git --exclude=validate-public-tree.sh .; then
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
  grep -Fq '使用环境' "$report"
  for heading in '## Use Environment' '## Installation Method' \
    '## `.re` Project Used' '## Successful Steps' '## Failed Steps' \
    '## Error Information' '## Generated Artifacts' \
    '## Language Suggestions' '## Would You Continue Using Revia?'; do
    grep -Fq "$heading" "$report"
  done
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

printf '%s\n' 'public tree validation passed'
