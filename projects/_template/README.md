# Revia Project Template / Revia 项目模板

## Goal / 目标

Describe the problem, intended behavior, and one falsifiable success condition.
说明问题、预期行为与一个可证伪的成功条件。

## Check And Run / 检查与运行

```bash
PROJECT=projects/_template
CACHE="$(mktemp -d)"
BUILD="$(mktemp -d)"
PROFILE=sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
TOOLCHAIN=sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
INPUT=sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee

node src/cli/re.js project-check --format json "$PROJECT"
```

The current public source workflow exposes `project-check` for this minimal
template. `project-translate` requires a project with translatable Agent or
business facts. Native `project-build` and
`project-run` require the versioned native candidate contracts documented in
the release trial kit; do not substitute the Node reference toolchain for
native release evidence.

当前公开源码流程为这个最小模板提供 `project-check`。
`project-translate` 需要包含可翻译 Agent 或业务事实的项目。native `project-build`
和 `project-run` 需要版本化 native 候选契约，详见发行试用包；不要把 Node 参考
工具链结果替代 native 发行证据。

## Result / 结果

Record the exact commit, target, commands, exit statuses, output digests, and
one conclusion. Keep unverified claims separate from observed results.
记录准确 commit、目标平台、命令、退出状态、输出摘要与一条结论。未验证主张应与实测结果分开。
