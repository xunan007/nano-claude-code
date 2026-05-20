# 项目说明

> 基于 learn-claude-code 开发的 TypeScript 版本，底层使用 DeepSeek API。

## 如何运行

- 在当前目录下创建 .env 文件：touch .env
- 填入 DEEPSEEK_API_KEY/DEEPSEEK_MODEL_ID/DEEPSEEK_BASE_URL

## 文档说明

- [message 格式转换｜s02](./doc/wiki/message%20格式转换.md)
- [待办写入工具｜s03](./doc/wiki/待办写入工具.md)
- [子代理｜s04](./doc/wiki/子代理.md)
- [技能系统｜s05](./doc/wiki/技能系统.md)
- [上下文压缩｜s06](./doc/wiki/上下文压缩.md)
- [s01-s06 代码重构](./doc/wiki/s01-s06%20代码重构.md)
- [权限系统｜s07](./doc/wiki/权限系统.md)
- [Hook 系统｜s08](./doc/wiki/Hook%20系统.md)
- [记忆系统｜s09](./doc/wiki/记忆系统.md)

## 不同分支对应的阶段代码

### s02 工具使用

**分支：**

- feat/s02

**核心功能说明：**

- 完成 Agent Loop
- 完成工具的注册

**测试指令：**

```
读一下 package.json 文件
```

```
在 src 目录下创建 greet.ts 文件，并编写一个 greet(name) 函数
```

```
修改 greet.ts，为函数新增一个文档字符串
```

```
阅读 greet.ts 文件验证改动是否生效
```

输出示例：[s02-1.md](./doc/output/s02/1.md)

### s03 待办写入

**分支：**

- feat/s03

**为什么需要这个功能：**

- 防止会话漂移

**核心功能说明：**

- 实现计划管理器，并注册成为一个工具，聚焦于**当前会话**的任务
- 如果连续几轮没有更新计划，需要提醒
- 把计划接入 agent loop

**其他功能说明：**

- 新增一个 message 的追踪日志，放便定位问题
- 修复打印逻辑，防止大模型返回的内容直接被跳过
- 新增多行输入功能

**测试指令：**

```
请先制定 todo 计划。
然后连续读取 package.json、tsconfig.json、tsconfig.build.json、eslint.config.js，并在读完后总结这些配置文件分别负责什么。
```

输出示例：[s03-1.md](./doc/output/s03/1.md)

### s04 子代理

**分支：**

- feat/s04

**为什么需要这个功能：**

- 给父上下文减负
- 子智能体有干净的上下文
- 让 prompt 更聚焦

**核心功能说明：**

- 新增 **task 工具**，父代理可以把聚焦任务委托给子代理
- 子代理使用全新的上下文，共享同一个工作目录和基础文件工具
- 子代理不能继续调用 task 工具，避免递归派发
- 子代理完成后只把最后的文本摘要返回给父代理，过程上下文会被丢弃

**其他功能说明：**

- 将模型调用改为可传入不同的 system prompt 和工具列表
- 父代理保留 todo 能力，子代理只保留 bash/read/write/edit 基础工具

**测试指令：**

```
请使用 task 工具派一个子代理阅读 package.json 和 tsconfig.json。然后根据它的摘要告诉我这个项目的运行方式。
```

输出示例：[s04-1.md](./doc/output/s04/1.md)

### s05 技能系统

**分支：**

- feat/s05

**为什么需要这个功能：**

- 避免 system prompt 变得越来越臃肿

**概念说明：**

- skill: 可选知识包，只有在某类任务需要时才能加载
- memory: 跨会话忍让有价值的信息，它是系统记住的东西，不是任务手册
- CLAUDE.md: 更稳定、更长期的规则说明，通常比单个 skill 更“全局”

**核心功能说明：**

- skill 轻量发现
- 按需深加载

**其他功能说明：**

- 父代理和子代理都可以调用 load_skill
- 技能目录约定为 .skills/\*\*/SKILL.md

**测试指令：**

先创建 .skills/project-summary/SKILL.md：

```md
---
name: project-summary
description: Summarize a TypeScript project by reading package and config files.
---

Read package.json first, then inspect TypeScript and lint config.
Summarize scripts, runtime entry points, and likely development workflow.
```

再运行：

```
请先加载 project-summary 技能，再阅读 package.json、tsconfig.json 和 eslint.config.js，总结这个项目如何运行。
```

输出示例：[s05-1.md](./doc/output/s05/1.md)

### s06 上下文压缩

**分支：**

- feat/s06

**为什么需要这个功能：**

- 上下文越来越快膨胀
    - 模型注意力被旧结果淹没
    - API 请求越来越重，越来越贵
    - 最终直接撞上上下文上限，任务中断

**概念说明：**

- 上下文窗口：模型这一轮真正能一起看到的输入容量
- 活跃上下文：当前这几轮继续工作时，最值得模型马上看到的那一部分
- 压缩：用更短的表示方式，保留继续工作真正需要的信息

**核心功能说明：**

- 实现上下文压缩策略
    - 微压缩：旧工具结果做微压缩
    - 完整压缩：整体历史过长时，做一次完整压缩
    - 大输出落盘：大结果写入磁盘，上下文只留预览

**其他功能说明：**

- 新增 compact 工具，允许模型主动压缩历史
- 压缩前会把完整 transcript 保存到 .transcripts
- 大工具输出会保存到 .task_outputs/tool-results

**测试指令：**

1. 先把参数改小

```ts
const CONTEXT_LIMIT = 8_000;
const PERSIST_THRESHOLD = 3_000;
const PREVIEW_CHARS = 500;
const KEEP_RECENT_TOOL_RESULTS = 2;
```

2. 执行指令

```md
请连续读取 README.md、src/index.ts、package.json、tsconfig.json、tsconfig.build.json、eslint.config.js、doc/wiki/message 格式转换.md、doc/wiki/待办写入工具.md、doc/wiki/子代理.md、doc/wiki/技能系统.md、doc/wiki/上下文压缩.md。每读取一个文件后，用 150 字左右记录关键信息。全部读取完成后，总结这个项目从 s02 到 s06 的能力演进。
```

**‼️：跑该指令会消耗比较多的 token，请慎重运行**

### s01-s06 代码重构

**分支：**

- refactor/s01-s06

**原代码存在问题：**

- 工具定义和工具执行分散维护，新增工具时容易漏同步
- compact 状态通过工具调用链路层层透传，边界不清晰
- message 转换、上下文处理、压缩逻辑混在全局函数里
- 上下文压缩没有形成独立模块，读写文件、落盘、压缩摘要职责交织
- bash/read/write/edit 等工具实现分散，后续扩展权限、日志、统计会比较困难

**重构方向：**

目标是把 s01-s06 叠加出来的单文件逻辑重新拆成清晰模块：

```txt
PromptBuilder      构建父代理和子代理 system prompt
SkillRegistry      发现 skill 目录并按需加载完整 skill
TodoManager        管理当前会话 todo 状态和 reminder
MessageCodec       负责内部消息格式和 OpenAI-compatible 消息格式互转
CompactManager     管理 compact state、大输出落盘、微压缩和完整压缩
ToolRuntime        统一管理工具定义、工具集合和工具执行
AgentLoop          管理 runOneTurn、agentLoop、runSubagent 的流程编排
ModelClient        封装模型调用和响应解析
```

重构时保持 LoopState 只表达 agent loop 自身状态，不把 TodoManager、SkillRegistry 等服务依赖塞进 state。

**存在问题：**

- agent loop 需要 hook，否则逻辑前处理和后处理会非常麻烦
- skills/todo 这些 domain service 混杂在 tool adapter，后续要拆除出去

### s07 权限系统

**分支：**

- feat/s07

**为什么需要这个功能：**

- 模型可能会写错文件、执行危险命令、在不该动手的时候动手
- 所以模型执行的意图必须经过权限检查

**核心功能说明：**

- 新增 PermissionManager，所有工具调用执行前先经过权限管线
- 权限管线顺序：bash 安全校验 -> deny rules -> mode check -> allow rules -> ask user
- 支持三种模式：default、plan、auto
- 支持 /mode 运行时切换模式，支持 /rules 查看当前规则

**其他功能说明：**

- 父代理和子代理共享同一个权限管理器
- bash 命令会先检查 sudo、递归删除、命令替换、IFS 注入和 shell 元字符
- 用户在询问中输入 always 后，会为当前工具追加临时 allow 规则

**测试指令：**

启动时选择 plan，再运行：

```
请创建 src/blocked.ts，内容随便写一句 hello。
```

预期：write_file 会被 plan mode 拒绝。

切换回 default：

```
/mode default
```

再运行：

```
请读取 package.json，然后尝试执行 echo hello。
```

预期：读取会自动允许，bash 会询问用户是否批准。

### s08 Hook 系统

**分支：**

- feat/s08

**为什么需要这个功能：**

- agent loop 随着功能的增加会有很多主线外的逻辑
- 需要有一个机制能够在主线运行的不同时机插入执行不同的动作

**核心功能说明：**

- 新增进程内 HookManager，通过 registerHook 注册 TypeScript hook
- 支持三个事件：SessionStart、PreToolUse、PostToolUse
- Hook 可以阻止执行、返回阻止原因、注入消息、改写工具输入
- 权限检查作为 PreToolUse hook 接入，不再写死在 ToolRuntime
- todo reminder 保留在 AgentLoop 主流程里

**其他功能说明：**

- Hook 不直接修改 messages，只返回结构化结果
- 父代理和子代理共享同一个 HookManager
- 当前单工具执行顺序：PreToolUse -> tool handler -> PostToolUse

**测试指令：**

启动时选择 plan，再运行：

```
请读取 package.json，然后创建 src/hook-blocked.ts。
```

预期：读取可以继续，写文件会被权限 hook 阻止。

**注意：block 以后其他 tool 被执行是合法的。**

### s09 记忆系统

**分支：**

- feat/s09

**为什么需要这个功能：**

- 有些信息应该跨会话保留，比如用户偏好、反复出现的反馈、项目里不容易从代码直接推导出的约定
- 但不是所有上下文都应该进入记忆，代码结构、临时任务状态、当前 TODO 都应该按需重新读取或留在当前会话
- 记忆系统要解决的是“下次还值得记住”的信息，而不是把聊天记录无差别塞进 prompt

**核心功能说明：**

- 新增 MemoryManager，启动时扫描 .memory/\*.md 并加载记忆
- 每条记忆是一个带 frontmatter 的 Markdown 文件，MEMORY.md 是自动重建的索引
- 支持四类记忆：user、feedback、project、reference
- 新增 save_memory 工具，模型可以在合适时保存跨会话信息
- system prompt 每轮都会重新构建，所以本轮刚保存的记忆会在下一轮可见

_注：真实设计可以通过 search_memory 动态加载记忆_

**其他功能说明：**

- 新增 /memories 命令，用来查看当前进程已加载的记忆列表
- 新增 DreamConsolidator 骨架，用于后续合并、去重、裁剪记忆

**测试指令：**

先运行：

```
请记住：我更喜欢 TypeScript 代码里用清晰的小模块，而不是把所有逻辑堆在一个大文件里。
```

预期：模型应该调用 save_memory，在 .memory 下生成对应 Markdown 文件，并重建 .memory/MEMORY.md。

然后运行：

```
/memories
```

预期：能看到刚保存的记忆。

再次运行：

```
根据你记住的偏好，简单说一下以后实现功能时应该注意什么。
```

预期：模型会参考刚写入的记忆回答。

### s10 系统提示词

**分支：**

- feat/s10

**为什么需要这个功能：**

- system prompt 不应该是一整段难维护的大字符串
- 随着 skill、memory、CLAUDE.md、动态上下文增加，需要有清晰的组装边界

**核心功能说明：**

- 新增 System Prompt Construction 思路，把提示词拆成独立 section
- 当前包含 core instructions、skill metadata、memory section、CLAUDE.md chain、dynamic context
- 使用 DYNAMIC_BOUNDARY 标记稳定内容和动态内容的分界
- **每一轮的 system prompt 都是重新构建的**

**其他功能说明：**

- 新增 /prompt 命令，用来查看完整组装后的 system prompt
- 新增 /sections 命令，用来查看当前 system prompt 的主要分段
- per-turn reminder 使用 system-reminder 形式注入，不混进稳定 system prompt

**测试指令：**

```
/sections
```

预期：能看到当前 system prompt 的分段标题和 DYNAMIC_BOUNDARY。

```
/prompt
```

预期：能看到完整组装后的 system prompt。

### s11 错误恢复

**分支：**

- feat/s11

**为什么需要这个功能：**

- agent 不应该因为一次输出截断、上下文过长或临时网络错误就直接崩掉
- 错误恢复的目标是让主循环在可恢复场景下自动调整并继续工作

**核心功能说明：**

- stop reason 命中 `max_tokens/length` 时，注入 continuation message 并继续生成（_这种情况下其实就是 output 太长被截断了，让模型继续输出就好了_）
- prompt 过长时，触发 compactHistory 压缩历史后重试
- 连接错误、限流、临时服务错误时，使用指数退避重试
- compact 自身失败时会写入降级摘要，避免恢复流程二次崩溃
