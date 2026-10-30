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

./bin/revia project-check "$PROJECT"
./bin/revia project-test "$PROJECT"
./bin/revia project-build "$PROJECT" "$CACHE" "$BUILD" "$PROFILE" "$TOOLCHAIN"
./bin/revia project-translate "$PROJECT" "$CACHE" "$BUILD" "$PROFILE" "$TOOLCHAIN" revia.app.main
./bin/revia project-run "$PROJECT" "$CACHE" "$BUILD" "$PROFILE" "$TOOLCHAIN" revia.app.main "$INPUT"
```

The profile, toolchain, and input digests above are deterministic starter
identifiers for this bounded native workflow, not production deployment
credentials or performance claims. Keep cache and build output outside the
project directory.

上述 profile、toolchain 与 input digest 是此有界 native 工作流的确定性起始标识，
不是生产部署凭据或性能结论。缓存和构建产物应放在项目目录之外。

## Result / 结果

Record the exact commit, target, commands, exit statuses, output digests, and
one conclusion. Keep unverified claims separate from observed results.
记录准确 commit、目标平台、命令、退出状态、输出摘要与一条结论。未验证主张应与实测结果分开。
