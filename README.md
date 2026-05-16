# 项目说明

> 基于 learn-claude-code 开发的 TypeScript 版本，底层使用 DeepSeek API。

## 如何运行

- 在当前目录下创建 .env 文件：`touch .env`
- 填入 DEEPSEEK_API_KEY/DEEPSEEK_MODEL_ID/DEEPSEEK_BASE_URL

## 文档说明

- [message 格式转换](./doc/wiki/message%20格式转换.md)

## 不同分支对应的阶段代码

### s02 工具使用

**分支：**

- feat/s02

**功能说明：**

- 完成 Agent Loop
- 完成工具的注册

**测试指令：**

- 读一下 package.json 文件
- 在 src 目录下创建 greet.ts 文件，并编写一个 greet(name) 函数
- 修改 greet.ts，为函数新增一个文档字符串
- 阅读 greet.ts 文件验证改动是否生效

**输出示例：**

参考：[s01.md](./output/s01.md)
