# Translation and Review Rendering / 翻译与审阅渲染

Revia keeps one checked semantic fact set behind every review projection:

```text
.re / project
    -> checked fact ledger
    -> semantic view IR
    -> text, HTML, or SVG
```

The renderer does not add, remove, or reinterpret facts. Each rendered fact
keeps its `fact_id`, graph revision, UID anchor, and evidence anchor so a
human-readable view can be traced back to the machine-readable contract.

## Readability At Project Scale / 面向大型项目的可读性

Project HTML output is organized by fact kind instead of one unbounded list:

- the header shows the graph revision and the non-authoritative review notice;
- summary cards show total facts and fact groups;
- the first few groups are open for immediate orientation;
- later groups remain collapsed until a reviewer requests them;
- each fact card shows its subject, stable fact ID, and evidence anchor.

SVG output uses the same fact order and grouping, with high-contrast section
bars, bounded row geometry, and metadata attached to every fact node. Text,
HTML, and SVG remain projections of the same facts; changing locale or media
does not change the semantic fact digest or translation receipt.

项目 HTML 输出按事实类型分组，而不是把所有事实堆成一条无限列表：

- 首部显示 graph revision，并明确这是非权威审阅视图；
- 摘要卡片显示事实总数和事实类别数；
- 前几个类别默认展开，帮助审阅者快速定位项目结构；
- 其余类别默认折叠，按需展开；
- 每条事实同时显示主题、稳定 fact ID 和 evidence anchor。

SVG 使用相同的事实顺序与分组，提供清晰的类别栏、稳定行高，并为每个事实节点保留元数据。
文本、HTML、SVG 都来自同一组事实；切换语言或媒体不会改变 semantic fact digest 或
translation receipt。

## Efficiency Boundary / 效率边界

The current optimization removes avoidable work in the project translation
path: the fact ledger is built once and reused by the semantic view, and text
rendering uses the already-rendered fact kind rather than searching the full
fact list for every row. This improves scaling behavior without changing the
semantic contract.

This is not a claim of production-scale throughput. The project build
benchmarks and native release gates remain the evidence source for measured
latency, memory, cache behavior, and platform support. Large projects still
need bounded project entry points, module-level execution artifacts, cache
invalidation evidence, and review pagination before they should be treated as
production workloads.

当前优化消除了项目翻译路径中的重复工作：事实账本只构建一次并被 semantic view 复用，
文本渲染直接使用已渲染的事实类别，不再为每一行重新扫描完整事实列表。该优化改善扩展
行为，但不改变语义契约。

这不等同于生产级吞吐证明。延迟、内存、缓存行为和平台支持仍以项目构建基准与 native
发行门禁为证据来源。大型项目要达到生产工作负载标准，还需要有界的项目入口、模块级执行
产物、缓存失效证据和审阅分页。

## Try It / 试用

```bash
./bin/revia project-translate --locale en-US --format html examples/agent-expense-review > review.html
./bin/revia project-translate --locale zh-CN --format svg examples/agent-expense-review > review.svg
```

The generated files are review projections, not audit authority. Use the
machine-readable manifest, audit output, and revision-bound evidence when
making security or release decisions.
