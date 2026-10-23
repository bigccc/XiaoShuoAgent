# Windows x64 构建与安装

目标为 Windows x64。当前版本号沿用 0.3.2，作为 Windows 补充构建提供在 [v0.3.2 发布页](https://github.com/bigccc/XiaoShuoAgent/releases/tag/v0.3.2)。

[EXE 安装包](https://github.com/bigccc/XiaoShuoAgent/releases/download/v0.3.2/XiaoShuoAgent-0.3.2-win32-x64-Setup.exe) · [免安装 ZIP](https://github.com/bigccc/XiaoShuoAgent/releases/download/v0.3.2/XiaoShuoAgent-win32-x64-0.3.2.zip) · [SHA-256](https://github.com/bigccc/XiaoShuoAgent/releases/download/v0.3.2/SHA256SUMS-windows.txt) · [Windows 验证记录](https://github.com/bigccc/XiaoShuoAgent/releases/download/v0.3.2/verification-windows.json)。原有 `SHA256SUMS.txt` 和 `verification.json` 仍对应 macOS，Windows 使用带 `-windows` 的独立附件。Windows 对应的源码提交见发布说明及验证记录，原有 v0.3.2 标签不移动。

## 构建

在 Windows 的项目目录，使用 Node.js 22.13+。Forge 8 的原生解压工具还需要 [Microsoft Visual C++ v14 运行库](https://learn.microsoft.com/en-us/cpp/windows/latest-supported-vc-redist)；x64 构建使用 x64 运行库。缺少 `VCRUNTIME140.dll` 会导致 `@electron-internal/extract-zip` 报 `ERR_DLOPEN_FAILED`，即使 `.node` 文件已经存在。

执行：

```powershell
npm ci
npm run typecheck
npm test
npm run make:win
```

产物位于 `release/v0.3.2/make/`：

- `squirrel.windows/x64/XiaoShuoAgent-0.3.2-win32-x64-Setup.exe`：安装器。
- `zip/win32/x64/`：免安装 ZIP，解压整个目录后运行 `XiaoShuoAgent.exe`。
- `squirrel.windows/x64/RELEASES` 与 `.nupkg`：安装器生成的配套元数据；当前应用未配置自动更新。

只需 ZIP 时运行 `npm run make:win:zip`。原有 macOS 构建命令保持不变。Squirrel 安装器请在 Windows 构建；依据 [Electron Forge 官方说明](https://www.electronforge.io/config/makers/squirrel.windows)，其他受支持构建环境是配有 Mono/Wine 的 Linux。

## 使用

安装 EXE 按当前 Windows 用户安装，创建快捷方式。ZIP 需要完整解压，不能只拷贝主 EXE。作品仍保存在当前 Windows 用户的应用数据目录；免安装包不把作品保存在程序旁。

Windows 使用原生标题栏，保留最小化、最大化和关闭按钮。`Ctrl+S` 保存，`Ctrl+1` 至 `Ctrl+5` 切换书架、创作、看稿、故事资料和设置；未保存内容与输入法组合输入仍受保护。

此构建未做 Windows 代码签名，系统可能显示未知发布者。使用 SHA-256 校验文件确认包完整。更新和卸载前可先在应用中导出 `.novel` 作品备份；不同系统间迁移使用作品包，密钥需要重新配置。

## 验收

2026-10-24：在 Parallels 的 Windows 11 Enterprise ARM64（10.0.26100）上，使用 Node 22.22.1 x64 构建并以 x64 兼容模式验证。尚未在原生 Intel/AMD Windows 电脑验收，也未测试 Windows 10。

- Windows 类型检查通过；服务层 757 项通过，1 项 macOS DMG 专用测试跳过。虚拟机命令为 `npm test -- --maxWorkers=2 --testTimeout=30000`。
- 首轮 Windows 服务测试暴露了测试自身的硬编码 `/` 路径、数据库未关闭便清理目录的问题，现已修复；长文本测试在默认 5 秒限制下超时，降低并发、放宽虚拟机超时后全部通过，断言未削弱。
- macOS 回归：758 项服务测试、9 项键盘 E2E、3 项保存/AI/导出桌面流程、类型检查、构建及 148 项明暗对比检查通过。
- Windows 打包应用：10 项键盘/未保存保护/安装维护测试通过，3 项作品重启保存、loopback AI 候选稿、导出与备份流程通过。所有模型响应来自本地测试服务，未调用付费服务商。
- 安装 EXE：两次静默安装成功，桌面/开始菜单快捷方式创建，安装后的保存与重启恢复测试通过。
- 卸载：返回成功，快捷方式、卸载注册项和应用归档移除；仍残留 `.dead`、`Update.exe`、`squirrel.exe` 和主 EXE，**不算完整文件清理通过**。残留记录见交付目录的验证信息；本次验收留下的程序残余已单独清理。用户卸载后如遇同样情况，可关闭程序后手动删除 `%LOCALAPPDATA%\XiaoShuoAgent` 的残余安装目录，不要删除保存作品的应用数据目录。
- 免安装 ZIP：在中文目录 `中文目录\小说工坊` 完整解压，启动、保存与重启恢复验收通过。
- ZIP 与安装器配套 NuGet 包的 `app.asar` SHA-256 相同；包内仅有运行产物、生产依赖、包信息及许可证，未包含项目源码、测试、文档、作品数据库或环境配置。

首轮桌面测试与安装/卸载测试并发时发生测试干扰，已改为串行复验；最终 Windows 键盘/维护 10 项全部通过。代码签名、原生 x64 设备与真实服务商调用仍未验收。

当前锁定的 Electron 44.5.1 和 Vitest 4.1.11 在构建时的 `npm audit` 中有原有的 1 项高危、2 项中危报告。本次预览构建保持版本与现有 macOS 构建一致，未顺带升级；依赖升级及回归仍待完成。
