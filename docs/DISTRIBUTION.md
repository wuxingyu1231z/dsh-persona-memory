# 安装与发布

当前包为 **0.8.6-alpha.1**，支持 DSH **`>=0.2.1-rc.3 <0.3.0-0`** / Cordis **`^4.0.5`**。rc.3、rc.4、rc.5 共用同一个发布包，后续 0.2.x 版本也不因精确版本号被拒绝。安装后从侧栏「人格与记忆」进入独立管理页；历史页可直接新建人格、本地预处理并自动导入整包会话。顶部「人格」页签提供选择、简介与管理页跳转。既有记忆保留，旧平铺项目目录由首次启动自动迁移。包内附带 `bin/preprocess.mjs` 离线工具。

| 形式 | Web | Desktop | 条件 |
| --- | --- | --- | --- |
| 本地 `.tgz` | CLI 或插件页 | 桌面应用插件入口 | 包内已构建 |
| npm 名称与版本 | CLI 或插件页 | 桌面应用插件入口 | 需要先公开或私有发布 |
| 本地目录 | CLI 或插件页 | 桌面应用插件入口 | 目录已构建，路径在 Host 机器上 |
| Git 源码 | 克隆、构建、安装本地目录 | 同左 | 首版不使用安装时构建脚本 |

Web 与 Desktop 使用同一个 `dsh.client.platform: web` 产物。Desktop 的 Host 启动其自带 Web Client，推荐在应用自身插件页安装。DSH 0.2.1-rc.5 允许 CLI 管理已初始化的 Desktop profile，但要求先完全退出 Desktop，避免并发修改。插件包不依赖 Electron API。

发布清单：

1. 在目标 Harness 版本执行 `npm run check`。
2. 执行 `npm pack --ignore-scripts --pack-destination releases`。
3. 检查压缩包含 Host 入口、Client 工厂、声明文件、bundle patch、文档和许可证。
4. 在全新的 Web 测试 profile 与 Desktop 测试安装中分别验证安装、刷新、重启和卸载。
5. 用户明确要求后再执行 npm 发布；包名可用性和发布凭证不由构建过程假定。

运行时使用宿主的 Cordis 与 LLM 包，避免把框架打包出第二个实例。Zod、YAML、文件锁及其依赖作为普通库内联，最终用户不需要单独安装；构建生成 THIRD_PARTY_NOTICES.md 并随包分发。宿主 peers 与 engines 使用一致的兼容范围；开发依赖固定 rc.3 以复现最低支持接口。发布前验证多版本矩阵，启动时检测必要接口。未来范围内更新允许安装，接口真的发生不兼容变化时仍需适配。

公开声明文件也引用 Zod 类型，因此包清单同时声明其精确版本的常规依赖；由包管理器自动处理，最终用户无需手动安装。

卸载插件仅解除运行时功能，不自动删除用户 memory 目录。Web 和 Desktop 可能共用该目录，不应在卸载其中一个客户端时删除全部记忆。

0.3.2-alpha.1 使用同一包入口和安装方式，兼容基线为 DSH 0.2.1-rc.3 / Cordis 4.0.5 / Node 24。新增的 `imports/`、`continuations/` 与 `semantic/` 位于既有 memory 根目录，不需要单独服务或迁移正式 Markdown 记忆。续聊调用宿主现有的 Session 创建、能力预设、Workspace 导航与持久化能力。语义服务完全可选。

本版本修复旧包因精确依赖 0.1.7-alpha.2 而被当前 DSH 拒绝的问题。安装新版包即可，无需 `allow-version`。构建前核对实际依赖版本，并在实际安装运行时的副本上执行兼容性回归。旧发布包保留用于记录，不能在当前 DSH 上继续使用。

0.3.2-alpha.1 进一步修复 Remote 子服务注入依赖，发布检查包含构建后 Client 的真实 Cordis 注册与 Remote 调用，不能仅用传入模拟 API 的组件测试替代此检查。安装该包后按应用提示重启或刷新，使新的浏览器工厂替换旧版本。

0.4.0-alpha.1 通过 `main` / `sidebar.panellist` 原生槽位扩展独立页面，清单显式依赖同版本 layout / sidebar 客户端插件。管理 Remote 接口不需要 Agent lookup；历史提取明确传入模型与项目，续聊只创建目标会话。深浅色原生选项使用 Canvas / CanvasText 成对系统色。发布检查增加无会话管理、显式模型提取、项目隔离及真实 SlotCore 注册；`npm run check:ui` 使用独立无界面 Edge profile 验证选项对比度、窄窗口和页面截图。Desktop 原生弹出菜单仍需实机检查。

0.5.0-alpha.1 改用原生 `conversation.view` 列表注册「人格」页签，移除输入框上方的 dock 占位。记忆由模型自动决策，旧待确认收据在启动时自动处理；列表保留纠正、忘掉、锁定，不再显示逐条过期表单。无需手动修改 memory 文件。

0.6.0-alpha.1 的目录布局版本为 2，具体结构及迁移方式见 [存储说明](STORAGE.md)。升级前关闭所有旧版 Host，不能用 0.5.x 同时操作新目录；不会改写人格核心、清空正式记忆或删除修订。Markdown 正文仍为真源，索引和画像可重建。

## 工作目录维护

`src/`、`tests/`、`scripts/`、`docs/`、`examples/` 和 `bin/` 为源码与维护资料，`lib/` 为当前构建，`releases/` 仅保留 0.7.2 及之后的发布包。`processed-imports/` 为用户本地预处理文件，不随包分发。

开发依赖链接到 `.test-output/compat-deps-0.2.1-rc.3/`，当前实际 DSH 指针仍可指向 rc.5，两者分别承担最低 API 类型检查和当前宿主运行验证。rc.3 / rc.5 的安装副本与 rc.4 的官方 npm 模块用于多版本回归，不应作为临时文件删除。`npm run check:compat` 在 `.test-output/compatibility-matrix/` 生成独立指针、日志和报告，不改写当前 `.installed-runtime.json`。升级验收可使用 `PERSONA_TEST_RUNTIME_CONFIG` 指定测试指针，`PERSONA_UPGRADE_RUNTIME` 指定旧 rc.3 副本。旧测试 profile 与缓存可清理。
