# Android arm64 / Termux Experimental Contract

> 中文摘要：Android 为独立实验性目标。真实 arm64 Android 设备运行密封二进制和试用包才能标为 `measured-native`；GitHub Android Emulator 结果必须标为 `measured-emulated`。

## Experimental Target / 实验目标

The target name is `android-arm64`. A candidate declares whether it is a
Termux-compatible executable, an Android app package, or both, plus its ABI and
Bionic/Termux compatibility boundary. The macOS arm64 archive cannot run on
Android and is never Android evidence.

目标名为 `android-arm64`。候选必须声明它是 Termux 兼容可执行文件、Android app package 或两者，
以及 ABI 和 Bionic/Termux 兼容边界。macOS arm64 归档不能在 Android 运行，也绝不是 Android 证据。

## Emulator Diagnostics / 模拟器诊断

A GitHub-hosted Linux job may build, install, and exercise an Android package
with the Android SDK emulator. This is useful functional diagnostics but must be
`measured-emulated`, recording emulator image, ABI, Android API level, binary
digest, command transcript, and output hashes.

GitHub 托管 Linux job 可以使用 Android SDK Emulator 构建、安装与试用 Android package。这是有用的
功能诊断，但必须标为 `measured-emulated`，并记录模拟器镜像、ABI、Android API level、二进制摘要、
命令记录和输出摘要。

## Native Device Evidence / 原生设备证据

`measured-native` requires a controlled physical arm64 Android device connected
through a self-hosted GitHub Actions runner or equivalent device lab. It runs the
sealed binary and public bounded trial kit, recording Android API level, ABI,
binary SHA-256, commands, exit codes, and output hashes. Device serials, user
accounts, IP addresses, credentials, and personal data are forbidden.

`measured-native` 需要受控的真实 arm64 Android 设备，通过自托管 GitHub Actions runner 或等价设备实验室
连接。它运行密封二进制和公开有界试用包，记录 Android API level、ABI、二进制 SHA-256、命令、退出码和输出摘要；
禁止设备序列号、账号、IP、凭据与个人数据。

## Stable Boundary / Stable 边界

Android is additive: it does not satisfy, replace, or weaken the six desktop
target requirements for Stable V1.0. It remains experimental until physical
device evidence passes, even if emulator diagnostics pass.

Android 是增量目标，不满足、不替代、也不弱化 Stable V1.0 的六桌面目标要求。即使模拟器诊断通过，
原生设备证据通过前它仍保持实验性。
