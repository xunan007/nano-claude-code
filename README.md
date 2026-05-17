# 项目说明

> 基于 learn-claude-code 开发的 TypeScript 版本，底层使用 DeepSeek API。

## 如何运行

- 在当前目录下创建 .env 文件：`touch .env`
- 填入 DEEPSEEK_API_KEY/DEEPSEEK_MODEL_ID/DEEPSEEK_BASE_URL

## 文档说明

- [message 格式转换｜s02](./doc/wiki/message%20格式转换.md)
- [待办写入工具｜s03](./doc/wiki/待办写入工具.md)

## 不同分支对应的阶段代码

### s02 工具使用

**分支：**

- feat/s02

**功能说明：**

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

**输出示例：**

参考：[s02.md](./output/s02.md)

### s03 待办写入

**分支：**

- feat/s03

**功能说明：**

- 实现计划管理器，并注册成为一个工具，聚焦于**当前会话**的任务
- 如果连续几轮没有更新计划，需要提醒
- 把计划接入 agent loop

**为什么需要：**

- 防止会话漂移

**测试指令：**

```
请先制定 todo 计划。
然后连续读取 package.json、tsconfig.json、tsconfig.build.json、eslint.config.js，并在读完后总结这些配置文件分别负责什么。
```
