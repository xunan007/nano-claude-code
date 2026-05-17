# 项目说明

> 基于 learn-claude-code 开发的 TypeScript 版本，底层使用 DeepSeek API。

## 如何运行

- 在当前目录下创建 .env 文件：`touch .env`
- 填入 DEEPSEEK_API_KEY/DEEPSEEK_MODEL_ID/DEEPSEEK_BASE_URL

## 文档说明

- [message 格式转换｜s02](./doc/wiki/message%20格式转换.md)
- [待办写入工具｜s03](./doc/wiki/待办写入工具.md)
- [子代理｜s04](./doc/wiki/子代理.md)

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
请使用 task 工具派一个子代理阅读 package.json 和 tsconfig.json，然后根据它的摘要告诉我这个项目的运行方式。
```
