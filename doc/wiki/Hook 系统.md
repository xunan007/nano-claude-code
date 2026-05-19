# Hook 系统

## 为什么需要 Hook

s08 的目标是给主流程增加可控扩展点，同时保持 agent loop 自己负责消息历史的写入。

真实实现里，hook 不应该依赖 shell 命令。更合适的形态是进程内事件总线：核心流程只在关键位置触发事件，具体策略用 TypeScript 函数注册进去。

## 当前事件

当前实现包含三个事件：

- SessionStart：会话启动时触发
- PreToolUse：单个工具执行前触发
- PostToolUse：单个工具执行后触发

## HookManager

`HookManager` 提供两个核心方法：

```ts
registerHook(event, name, handler)
runHooks(event, context)
```

handler 可以返回：

```ts
type HookResult = {
    blocked?: boolean;
    blockReason?: string;
    messages?: string[];
    updatedInput?: Record<string, unknown>;
};
```

- blocked：阻止后续执行
- blockReason：阻止原因
- messages：返回额外上下文，由主流程决定如何注入
- updatedInput：改写当前工具输入

## 内置 Hook

当前内置了一类 hook：

- permission hook：注册到 PreToolUse

权限系统因此不再由 `ToolRuntime` 单独判断，而是作为工具执行前的一个策略 hook。

todo reminder 保留在 `AgentLoop.runOneTurn`，因为它属于 todo 工具状态策略，不是外部扩展点。

## 执行顺序

单个工具调用：

```txt
tool call
  -> PreToolUse hooks
  -> tool handler
  -> PostToolUse hooks
  -> tool_result
```

## 边界

Hook 适合承载横切策略：

- 权限
- 审计
- 输入改写
- 工具结果补充上下文

Hook 不直接修改 `messages`。它只返回结构化结果，主流程负责把 hook message、tool result、assistant message 写入历史。

Hook 不应该替代主循环骨架和核心工具状态策略：

- 模型调用
- assistant message 入历史
- tool result 入历史
- stop reason 判断
- turn 状态推进
- todo 状态提醒
- compact 历史替换

这样 agent loop 仍然负责编排，hook 负责扩展。
