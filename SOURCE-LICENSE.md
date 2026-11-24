# Source License Scope

## Effective Scope

The source files introduced by the open development transition are licensed
under the unmodified Mozilla Public License 2.0 in `LICENSE`, effective from
the first public source-transition commit.

This document describes scope; it is not an additional license and does not
replace the official license text.

## Historical Assets

Existing preview and RC1 binaries, archives, manifests, and notices retain the
terms under which those exact assets were published:

- `LICENSE-PREVIEW-0.1.md` applies to the historical `0.1-preview` line.
- `LICENSE-RC.md` applies to the historical `v1.0.0-rc.1` candidate.
- Third-party runtime notices remain in their corresponding `runtime/`
  license files.

Publishing source does not retroactively relicense historical assets, and
historical asset terms do not restrict newly published source that is covered
by MPL-2.0.

## RC2.2.1 Binary Scope

The published `v1.0.0-rc.2.2.1` binaries are distributed under MPL-2.0, the same
license as the source they are built from. Section 3.2(b) of that license
permits an executable form to be distributed under its own terms, and section
3.2(a) requires the corresponding source to be available: the export manifest
records `source_commit`, and that commit is public.

The export manifest also carries `LICENSE-RC.md`. That file states its own scope
as `v1.0.0-rc.1` only and ships unchanged as a historical notice; it does not
govern, extend, or restrict the RC2.2.1 binaries.

## RC2.2.1 二进制许可范围

已发布的 `v1.0.0-rc.2.2.1` 二进制按 MPL-2.0 分发，与其构建所用源码同一许可。
该许可第 3.2(b) 条允许可执行形式按本许可分发，第 3.2(a) 条要求提供对应源码：
导出 manifest 记录了 `source_commit`，该提交是公开的。

导出 manifest 同时包含 `LICENSE-RC.md`。该文件自述适用范围仅限 `v1.0.0-rc.1`，
作为历史声明原样随包分发；它不构成、不扩展、也不限制 RC2.2.1 二进制的条款。

## Contributions

Contributions to the public source repository are accepted under the project
contribution process and must preserve applicable license and attribution
notices. Contributors must have the right to submit their work. Do not submit
credentials, personal data, private infrastructure material, or code whose
provenance is uncertain.

The project does not require a personal email address in source files,
documentation, or new commit metadata. Project-domain contact details may be
added only after the domain and mail channel are operational.
