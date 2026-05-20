# Message 格式转换

当前实现保留了教程里的 Anthropic-like 内部消息结构，但实际请求走的是 OpenAI SDK + DeepSeek OpenAI-compatible API。因此消息在运行时会经过三层格式：

1. 内部 agent loop 格式
2. 发送前的 normalize 格式
3. OpenAI SDK / DeepSeek 请求与响应格式

核心原则是：agent loop 只理解内部格式；模型适配层负责把内部格式翻译成 DeepSeek 能接受的格式。

## 内部格式

内部消息类型是：

```ts
type Message = {
    role: "user" | "assistant";
    content: string | ContentBlock[];
    reasoningContent?: string;
};
```

content 可以是普通字符串，也可以是 block 数组：

```ts
type ContentBlock =
    | { type: "text"; text: string }
    | {
          type: "tool_use";
          id: string;
          name: string;
          input: Record<string, unknown>;
      }
    | {
          type: "tool_result";
          tool_use_id: string;
          content: string;
      };
```

内部 history 的典型形态：

```ts
[
    { role: "user", content: "读取 package.json" },
    {
        role: "assistant",
        content: [
            {
                type: "tool_use",
                id: "call_1",
                name: "read_file",
                input: { path: "package.json" },
            },
        ],
        reasoningContent: "...",
    },
    {
        role: "user",
        content: [
            {
                type: "tool_result",
                tool_use_id: "call_1",
                content: "{ ... }",
            },
        ],
    },
];
```

这里的 tool_use / tool_result 是为了延续原 Python 教程的概念。DeepSeek/OpenAI API 并不直接认识这两个 block。

最终上下文对话的历史存在 state.messages 当中。

## 请求 message 封装

- toOpenAIMessages
    - 把 role=system 的 prompt 添加进去
    - normalizeMessages 处理清理和调整内部消息
        - 清理 block 里的元数据，\_开头的字段全去掉
        - tool_use 缺失对应 tool_result，补一条
        - 合并相邻同 role 的消息
    - .flatMap(contentBlocksToOpenAIMessage) 转换成 OpenAI message
        - role=user，content 是 string，直接转换成一条 OpenAI user message
        - role=user，content 是 block 数组：text block 合并，tool_result block 转成独立的 OpenAI role=tool message
        - role=assistant，content 是 block 数组：text block 合并，tool_use block 统一放在 OpenAI assistant message 的 tool_calls 下面
        - 透传 DeepSeek 的 reasoningContent

## LLM 回包 message 处理

- fromOpenAIMessage，生成一个 message
    - role=assistant
    - content 是一个 text block 和 tool_call 数组转换成多个的 tool_use block
    - 透传 reasoningContent

## runOneTurn 中的完整流向

一次 loop 的数据流是：

```txt
state.messages
    -> createMessage()
    -> toOpenAIMessages()
    -> normalizeMessages()
    -> contentBlocksToOpenAIMessage()
    -> OpenAI SDK / DeepSeek API
    -> fromOpenAIMessage()
    -> assistant Message 写回 state.messages
    -> executeToolCalls()
    -> tool_result 写回 state.messages
```

如果模型没有继续请求工具，runOneTurn() 返回 false，agentLoop() 结束。

如果模型返回工具调用，executeToolCalls() 会根据 tool_use.name 查找 TOOL_HANDLERS：

```ts
const TOOL_HANDLERS = {
    bash,
    read_file,
    write_file,
    edit_file,
};
```

工具输出会包装成内部 tool_result：

```ts
{
    type: "tool_result",
    tool_use_id: block.id,
    content: toolOutput,
}
```

然后作为 user message 追加回 history：

```ts
state.messages.push({ role: "user", content: results });
```

## 总结

内部 agent loop 维护的是教程风格：

```txt
text / tool_use / tool_result
```

请求 DeepSeek 时转换成 OpenAI-compatible 风格：

```txt
content / tool_calls / role: "tool" / tool_call_id
```

DeepSeek thinking mode 额外需要：

```txt
reasoning_content
```

这个字段不属于原 Python 教程，也不是 OpenAI SDK 标准字段，只是 DeepSeek 协议要求的透传字段。
