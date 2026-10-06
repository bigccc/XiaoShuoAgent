---
status: accepted
---

# 使用 Electron 与 SQLite 构建本地桌面工作台

采用 Electron + React + TypeScript + SQLite，并以 Electron Forge 打包，使编辑界面、AI 编排和文档处理使用统一的主要开发语言，同时提供无需使用者配置开发环境的 macOS App。这是工程判断，已随 Q18 的「OK」确认，不是框架能力比较的绝对结论。

考虑过 Tauri：它也支持 macOS 分发，但开发链涉及 Rust；选择 Electron 接受携带 Chromium/Node 运行时的包体与更新维护成本，以减少当前项目语言和工具链的分散。依据：[Electron 打包教程](https://www.electronjs.org/docs/latest/tutorial/tutorial-packaging)、[Tauri 开发前提](https://tauri.app/start/prerequisites/)。

SQLite 对应本机单用户作品存储；如果选择原生驱动，其 Electron ABI 和 arm64/x64 重建是打包验收的一部分。两套架构安装验证与正式签名公证分别执行，不能以在当前机器启动成功替代。依据：[SQLite 使用场景](https://www.sqlite.org/whentouse.html)、[Electron 原生模块](https://www.electronjs.org/docs/latest/tutorial/using-native-node-modules)、[Forge 签名指南](https://www.electronforge.io/guides/code-signing/code-signing-macos)。
