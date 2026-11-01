# 兼容范围与多版本验证

当前发布 **0.8.4-alpha.1**，使用同一个包支持 DSH **`>=0.2.1-rc.3 <0.3.0-0`**，Cordis **`^4.0.5`**。rc.3、rc.4、rc.5 共用产物，范围内的后续 0.2.x 预发布版与正式版允许继续使用，不需要为每次宿主升级重新打包。

## 兼容策略

- `engines.dsh` 与所有 DSH 宿主 peers 声明相同范围；同时验证两者，避免只放开引擎却留下精确 peer 约束。
- 开发依赖精确固定到最低支持版本 rc.3。固定的是开发与类型检查环境，不限制最终用户安装的宿主版本。
- 构建使用宿主的 Cordis、Agent、LLM、Session、Workspace 和 Remote，不把这些框架打入插件。
- 启动先检查必要的 Host / Client 方法，再打开记忆或挂载界面。缺少接口时给出具体名称，不静默修改记忆。
- 以同一份构建分别运行三个版本的功能回归，记录构建指纹，禁止各版本之间偷偷重新构建。
- 0.3.0（含预发布）及以上不在当前范围内。范围内未来版本可以安装，实际行为仍取决于接口是否保持兼容，无法预先保证未发布版本。

DSH 官方兼容检查将预发布版本纳入范围，因此后续 rc 和 0.2.x 预发布版也可通过。测试同时覆盖 rc.6、0.2.1 正式版和 0.2.2 预发布版等版本号的允许行为；这些版本号测试不代表已经执行了未来宿主的功能回归。

## 从源码重复验证

使用 Node 24+，在仓库根目录运行：

```bash
npm install --ignore-scripts
npm run prepare:compat
npm run check:compat
```

`prepare:compat` 从 npm 获取 rc.3 / rc.4 / rc.5 的官方模块和同版本测试工具，递归补齐官方宿主 peer，禁用安装脚本，全部写入 `.test-output/compat-deps-<version>/`。已有开发工具保留。也可只准备一个版本，例如 `npm run prepare:compat -- 0.2.1-rc.4`。

`check:compat` 默认先对最低版本进行类型检查并构建一次，再用这份产物在三个运行时分别执行源码和构建后测试。若本地已有 `.test-output/dsh-runtime-<version>/dsh/` 安装包副本，则优先使用实际安装模块；否则使用官方 npm 模块。每个版本使用独立测试指针，不改写当前 `.installed-runtime.json`。日志与报告位于 `.test-output/compatibility-matrix/`。

也可以复制当前 Desktop 的公共运行时，安装目录只读：

```bash
node scripts/prepare-installed-runtime.mjs "/absolute/path/to/DeepSeekHarness"
npm run check:installed
```

`scripts/link-compat-deps.mjs` 默认为开发基线 rc.3，也可显式传入已准备的版本。它在更换任何链接前检查所有依赖，避免缺包时留下半切换环境。常规源码构建仍可执行 `npm run check`。

## 安装和升级验收

在已准备实际 Desktop 副本、自带 pnpm 和发布包的环境中：

```bash
npm pack --ignore-scripts --pack-destination releases
node scripts/smoke-install.mjs --upgrade
```

该流程在独立 Web profile 中先用 rc.3 安装旧 0.8.3，写入测试人格、跨项目及项目记忆和会话选择，然后用所选宿主安装当前插件并重启核对数据。`PERSONA_TEST_RUNTIME_CONFIG` 可指定矩阵生成的运行时指针，`PERSONA_UPGRADE_RUNTIME` 可指定旧 rc.3 副本。每个宿主单独保存 `.test-output/installed-transaction-report-<version>.json`。无需版本豁免，不操作真实用户 profile。

## 已有发布包

| 插件包 | 安装声明 |
| --- | --- |
| 现有 0.7.2～0.8.1 包 | 精确 rc.3 |
| 0.8.2-alpha.1 | 精确 rc.5 |
| **0.8.4-alpha.1** | **rc.3 起的 0.2.x 范围** |

安装新版后完全退出并重启应用。若插件页要求先卸载旧版，请保留 memory 目录。记忆布局继续为 2，已有 Markdown、索引与历史归档可沿用。旧版本验证过程见 [VALIDATION.md](../VALIDATION.md)。模型测试使用本地假适配器；功能矩阵不等同于真实 Desktop 窗口或真实模型质量验收。
