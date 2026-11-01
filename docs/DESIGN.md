# 设计约定

本插件独立于 Harness 主仓库，以 Cordis bundle 分发。Web 与 Desktop 共用 browser Client 工厂和 Host 服务。当前版本基线为 DSH 0.2.1-rc.3，推荐使用桌面应用自身的插件安装入口。

已实现后台学习、候选处理、来源去重、锁定与过期、持久队列和配置式工具校验，规则以 [学习说明](LEARNING.md) 为准。第三阶段加入历史导入、原生续聊与可选语义召回，规则以 [导入说明](IMPORT.md) 为准。

人格在同一会话中切换，完整聊天历史仍可参考；当前轮次固定人格与记忆快照，下一轮读取用户新选择。人格不等同于 preset，切换不改动运行中会话的插件组合或工具权限。长期偏好默认属于当前人格；项目记忆还需要匹配当前项目。全局或跨人格共享只在后续版本通过用户明确操作加入。

主要内容来源为本地 Markdown。PERSONA.md 保存人格核心，memories 下各条目保存主题、正文、类别、作用域、来源和版本。画像、索引和摘要可在后续阶段从这些条目生成，避免形成互相矛盾的第二套存储。目录在 Harness 用户 home 下，配置可覆盖。

Host 服务使用共享 schema 定义严格的 Gateway 接口。插件不单独开放网络端口。人格通过 systemPrompt.section 贡献，相关记忆通过 agent/pre-step 写入正常 user/message 路径；模型看到的内容均由原有会话日志记录，不修改 agent-loop。

界面展示人格摘要、记忆列表与下轮选择，提供新建、编辑、明确保存、纠正和遗忘。保存携带版本，旧页面不能覆盖新版本；多个进程用同一目录锁串行化写入。文件编辑后显式刷新，当前轮次保持其快照。

自动学习依据原始消息及其发生时的人格归属，不能依据任务执行时界面当前选中的人格。用户明确纠正高于推断，临时要求不升级为长期偏好；过期与冲突通过有效版本及适用条件处理。人格核心由用户编辑，用户锁定的内容不能被后台覆盖。

历史导入支持 DeepSeek、ChatGPT JSON 和角色标记 Markdown，提供分支预览、新建人格、合并和分别选择目标。原始时间决定新旧，缺失时记为未知，导入时间不作为偏好优先级；同一来源在多个分支不能计作独立证据。只接受能定位到真实用户原话的候选，仍须用户审阅；模型摘要与人格风格草稿不会直接当成用户记忆。

续聊在独立的 Session 中构造完整且已闭合的历史轮次，以 seed 初始化 Agent，避免创建后补写历史造成轮次计数失配。历史助手消息带完整文本流，保证客户端可渲染。长历史通过 Harness 的 surface replacement 压缩模型视图，append-origin 原文继续保留。创建回执与当前人格选择先落盘，创建和持久化成功后才返回 ID，客户端调用现有 uiWorkspace.openSession 导航。后续用户正常提交消息，历史正文不重新进入后台学习。

嵌入服务为可选依赖，在 Host 过滤人格、项目和过期状态后才发送文本。向量缓存按模型端点、人格和项目分开，以内容哈希校验；关键词与语义排名融合。返回异常时走关键词召回；遗忘同时清除向量，晚到的生成结果在写锁内复查有效记录。

参考项目及原始设计来源：

- Letta：persona 与 human 记忆块分离及只读块：https://docs.letta.com/v1-sdk/memory/memory-blocks
- LangMem：命名空间、记忆分类与后台整理：https://langchain-ai.github.io/langmem/concepts/conceptual_guide/
- Engram：稳定主题标识与渐进检索：https://github.com/Gentleman-Programming/engram
- Mem0：多级作用域与混合召回：https://github.com/mem0ai/mem0
- Claude Code：简短索引与独立主题文件：https://code.claude.com/docs/en/memory
- 本工作区独立项目 dsh-conversation-bridge（MIT）：参考官方导出图结构与原生续聊思路；本插件按当前 Harness 基线独立实现，不依赖或修改该项目。
- Ollama embeddings 官方协议：https://docs.ollama.com/api/embed

参考机制不代表依赖或整体移植上述系统。当前实现只依赖宿主运行时与内联的普通库。
