# CLI Protocol / CLI 协议

Revia reads UTF-8 `.re` files and returns stdout, stderr, and an exit status.
Revia 读取 UTF-8 `.re` 文件，并返回 stdout、stderr 与退出状态。

| Status / 状态 | Meaning / 含义 |
|---:|---|
| `0` | Success / 成功 |
| `64` | Invalid command / 无效命令 |
| `65` | Source or project check failed / 源码或项目检查失败 |
| `69` | No executable for the platform / 当前平台无可执行文件 |
| `70` | Runtime or integrity failure / 运行或完整性失败 |

Use `--format json` where available. Branch on schema identifiers, result
kinds, stable codes, and exit status.
可用时使用 `--format json`，按 schema 标识、结果类型、稳定代码与退出状态处理结果。

The launcher verifies archive and executable SHA-256 digests against
[runtime/checksums.txt](../runtime/checksums.txt).
启动器依据 [runtime/checksums.txt](../runtime/checksums.txt) 校验归档与可执行文件的 SHA-256。
