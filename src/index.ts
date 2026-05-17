#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { fileURLToPath } from "node:url";

import { config as loadEnvFile } from "dotenv";
import OpenAI from "openai";
import type {
    ChatCompletionAssistantMessageParam,
    ChatCompletionMessageParam,
    ChatCompletionMessageToolCall,
    ChatCompletionTool,
} from "openai/resources/chat/completions";

// 两种角色
type Role = "user" | "assistant";

// 三种消息类型

type TextBlock = {
    type: "text";
    text: string;
};

type ToolUseBlock = {
    type: "tool_use";
    id: string;
    name: string;
    input: Record<string, unknown>;
};

type ToolResultBlock = {
    type: "tool_result";
    tool_use_id: string;
    content: string;
};

type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;

type Message = {
    role: Role;
    content: string | ContentBlock[];
    reasoningContent?: string; // 兼容 DeepSeek 逻辑
};

type ModelResponse = {
    content: ContentBlock[];
    stopReason: string | null;
    reasoningContent?: string; // DeepSeek 特有
};

type PlanStatus = "pending" | "in_progress" | "completed";

type PlanItem = {
    content: string; // 这一步要做什么
    status: PlanStatus; // 这一步现在处于什么状态
    activeForm: string; // 当它正在进行时的描述
};

type PlanningState = {
    items: PlanItem[];
    roundsSinceUpdate: number; // 连续过去多少轮还没有更新计划
};

type AssistantMessageWithReasoning = {
    content: string | null;
    reasoning_content?: string;
    tool_calls?: ChatCompletionMessageToolCall[];
};

type AssistantMessageParamWithReasoning =
    ChatCompletionAssistantMessageParam & {
        reasoning_content?: string;
    };

// 多轮执行依赖的状态
type LoopState = {
    messages: Message[]; // 所有历史都写入这里
    turnCount: number; // 当前在第几轮
    transitionReason?: "tool_result"; // 下一轮执行的理由
};

const DEFAULT_MAX_TOKENS = 8000;
const BASH_TIMEOUT_MS = 120_000;
const MAX_TOOL_OUTPUT_CHARS = 50_000;
const WORKDIR = process.cwd();
const PLAN_REMINDER_INTERVAL = 3;
const MESSAGE_TRACE_PATH = `debug/messages-${formatLocalTimestamp()}.json`;
const SYSTEM = `You are a coding agent at ${WORKDIR}.
Use the todo tool for multi-step work.
Use the task tool to delegate focused exploration or subtasks when it keeps the parent context cleaner.
Keep exactly one step in_progress when a task has multiple steps.
Refresh the plan as work advances. Prefer tools over prose.`;
const SUBAGENT_SYSTEM = `You are a coding subagent at ${WORKDIR}.
Complete the given task with the available filesystem tools, then summarize your findings.
Return only the useful final summary.`;

// 界定哪些操作是安全的
const CONCURRENCY_SAFE = new Set(["read_file"]); // eslint-disable-line
const CONCURRENCY_UNSAFE = new Set(["write_file", "edit_file", "todo"]); // eslint-disable-line

const FILE_TOOLS: ChatCompletionTool[] = [
    {
        type: "function",
        function: {
            name: "bash",
            description: "Run a shell command in the current workspace.",
            parameters: {
                type: "object",
                properties: { command: { type: "string" } },
                required: ["command"],
                additionalProperties: false,
            },
        },
    },
    {
        type: "function",
        function: {
            name: "read_file",
            description: "Read file contents.",
            parameters: {
                type: "object",
                properties: {
                    path: { type: "string" },
                    limit: { type: "integer" },
                },
                required: ["path"],
                additionalProperties: false,
            },
        },
    },
    {
        type: "function",
        function: {
            name: "write_file",
            description: "Write content to file.",
            parameters: {
                type: "object",
                properties: {
                    path: { type: "string" },
                    content: { type: "string" },
                },
                required: ["path", "content"],
                additionalProperties: false,
            },
        },
    },
    {
        type: "function",
        function: {
            name: "edit_file",
            description: "Replace exact text in file.",
            parameters: {
                type: "object",
                properties: {
                    path: { type: "string" },
                    old_text: { type: "string" },
                    new_text: { type: "string" },
                },
                required: ["path", "old_text", "new_text"],
                additionalProperties: false,
            },
        },
    },
];

const TODO_TOOL: ChatCompletionTool = {
    type: "function",
    function: {
        name: "todo",
        description: "Rewrite the current session plan for multi-step work.",
        parameters: {
            type: "object",
            properties: {
                items: {
                    type: "array",
                    items: {
                        type: "object",
                        properties: {
                            content: { type: "string" },
                            status: {
                                type: "string",
                                enum: ["pending", "in_progress", "completed"],
                            },
                            activeForm: {
                                type: "string",
                                description:
                                    "Optional present-continuous label.",
                            },
                        },
                        required: ["content", "status"],
                        additionalProperties: false,
                    },
                },
            },
            required: ["items"],
            additionalProperties: false,
        },
    },
};

const TASK_TOOL: ChatCompletionTool = {
    type: "function",
    function: {
        name: "task",
        description:
            "Spawn a subagent with fresh context. It shares the filesystem but not conversation history.",
        parameters: {
            type: "object",
            properties: {
                prompt: { type: "string" },
                description: {
                    type: "string",
                    description: "Short description of the delegated task.",
                },
            },
            required: ["prompt"],
            additionalProperties: false,
        },
    },
};

const CHILD_TOOLS: ChatCompletionTool[] = FILE_TOOLS;
const PARENT_TOOLS: ChatCompletionTool[] = [
    ...FILE_TOOLS,
    TODO_TOOL,
    TASK_TOOL,
];

type MessageCreateOptions = {
    system: string;
    tools: ChatCompletionTool[];
};

function loadDotEnv(path = ".env"): void {
    loadEnvFile({ path, override: true, quiet: true });
}

function createInitialState(messages: Message[]): LoopState {
    return {
        messages,
        turnCount: 1,
    };
}

function formatLocalTimestamp(date = new Date()): string {
    const pad = (value: number, length = 2): string =>
        String(value).padStart(length, "0");

    return [
        date.getFullYear(),
        "-",
        pad(date.getMonth() + 1),
        "-",
        pad(date.getDate()),
        "T",
        pad(date.getHours()),
        "-",
        pad(date.getMinutes()),
        "-",
        pad(date.getSeconds()),
        ".",
        pad(date.getMilliseconds(), 3),
    ].join("");
}

class TodoManager {
    state: PlanningState = {
        items: [],
        roundsSinceUpdate: 0,
    };
    // TODO 工具执行的入口
    update(items: unknown[]): string {
        // 尽量让计划步骤不要太长
        if (items.length > 12) {
            throw new Error("Keep the session plan short (max 12 items)");
        }

        const normalized: PlanItem[] = [];
        let inProgressCount = 0;

        for (const [index, rawItem] of items.entries()) {
            if (
                rawItem === null ||
                typeof rawItem !== "object" ||
                Array.isArray(rawItem)
            ) {
                throw new Error(`Item ${index}: item must be an object`);
            }

            const item = rawItem as Record<string, unknown>;
            const content = String(item.content ?? "").trim();
            const status = String(item.status ?? "pending").toLowerCase();
            const activeForm = String(item.activeForm ?? "").trim();

            if (!content) {
                throw new Error(`Item ${index}: content required`);
            }
            if (!this.isPlanStatus(status)) {
                throw new Error(`Item ${index}: invalid status '${status}'`);
            }
            if (status === "in_progress") {
                inProgressCount += 1;
            }

            normalized.push({
                content,
                status,
                activeForm,
            });
        }

        if (inProgressCount > 1) {
            throw new Error("Only one plan item can be in_progress");
        }

        this.state.items = normalized;
        this.state.roundsSinceUpdate = 0;
        // 返回渲染后的计划
        return this.render();
    }

    noteRoundWithoutUpdate(): void {
        this.state.roundsSinceUpdate += 1;
    }

    reminder(): string | undefined {
        if (this.state.items.length === 0) {
            return undefined;
        }
        if (this.state.roundsSinceUpdate < PLAN_REMINDER_INTERVAL) {
            return undefined;
        }
        return "<reminder>Refresh your current plan before continuing.</reminder>";
    }

    render(): string {
        if (this.state.items.length === 0) {
            return "No session plan yet.";
        }

        const lines = this.state.items.map((item) => {
            const marker = {
                pending: "[ ]",
                in_progress: "[>]",
                completed: "[x]",
            }[item.status];
            const activeSuffix =
                item.status === "in_progress" && item.activeForm
                    ? ` (${item.activeForm})`
                    : "";
            return `${marker} ${item.content}${activeSuffix}`;
        });
        const completed = this.state.items.filter(
            (item) => item.status === "completed",
        ).length;

        lines.push(`\n(${completed}/${this.state.items.length} completed)`);
        return lines.join("\n");
    }

    private isPlanStatus(status: string): status is PlanStatus {
        return ["pending", "in_progress", "completed"].includes(status);
    }
}

const TODO = new TodoManager();

// 防止路径逃逸
function safePath(path: string): string {
    const resolved = resolve(WORKDIR, path);
    const rel = relative(WORKDIR, resolved);
    if (rel.startsWith("..") || isAbsolute(rel)) {
        throw new Error(`Path escapes workspace: ${path}`);
    }
    return resolved;
}

function runBash(command: string): string {
    const dangerous = ["rm -rf /", "sudo", "shutdown", "reboot", "> /dev/"];
    if (dangerous.some((item) => command.includes(item))) {
        return "Error: Dangerous command blocked";
    }

    const result = spawnSync(command, {
        shell: true,
        cwd: WORKDIR,
        encoding: "utf8",
        timeout: BASH_TIMEOUT_MS,
    });

    if (result.error) {
        if (result.error.message.includes("ETIMEDOUT")) {
            return "Error: Timeout (120s)";
        }
        return `Error: ${result.error.message}`;
    }

    const stdout = result.stdout ?? "";
    const stderr = result.stderr ?? "";
    const combined = `${stdout}${stderr}`.trim();
    return combined ? combined.slice(0, MAX_TOOL_OUTPUT_CHARS) : "(no output)";
}

function runRead(path: string, limit?: number): string {
    try {
        const text = readFileSync(safePath(path), "utf8");
        const lines = text.split(/\r?\n/);
        const limitedLines =
            limit !== undefined && limit < lines.length
                ? [
                      ...lines.slice(0, limit),
                      `... (${lines.length - limit} more lines)`,
                  ]
                : lines;
        return limitedLines.join("\n").slice(0, MAX_TOOL_OUTPUT_CHARS);
    } catch (error: unknown) {
        return `Error: ${error instanceof Error ? error.message : String(error)}`;
    }
}

function runWrite(path: string, content: string): string {
    try {
        const resolvedPath = safePath(path);
        mkdirSync(dirname(resolvedPath), { recursive: true });
        writeFileSync(resolvedPath, content);
        return `Wrote ${content.length} bytes to ${path}`;
    } catch (error: unknown) {
        return `Error: ${error instanceof Error ? error.message : String(error)}`;
    }
}

function runEdit(path: string, oldText: string, newText: string): string {
    try {
        const resolvedPath = safePath(path);
        const content = readFileSync(resolvedPath, "utf8");
        if (!content.includes(oldText)) {
            return `Error: Text not found in ${path}`;
        }
        writeFileSync(resolvedPath, content.replace(oldText, newText));
        return `Edited ${path}`;
    } catch (error: unknown) {
        return `Error: ${error instanceof Error ? error.message : String(error)}`;
    }
}

// 提取 block.type === "text" 的内容
function extractText(message: Message): string {
    if (!Array.isArray(message.content)) {
        return "";
    }

    return message.content
        .filter((block): block is TextBlock => block.type === "text")
        .map((block) => block.text)
        .filter(Boolean)
        .join("\n")
        .trim();
}

function extractAssistantTexts(messages: Message[]): string {
    return messages
        .filter((message) => message.role === "assistant")
        .map(extractText)
        .filter(Boolean)
        .join("\n\n")
        .trim();
}

function parseToolArguments(args: string): Record<string, unknown> {
    try {
        const parsed = JSON.parse(args) as unknown;
        return parsed && typeof parsed === "object" && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : {};
    } catch {
        return {};
    }
}

function requireString(input: Record<string, unknown>, key: string): string {
    const value = input[key];
    if (typeof value !== "string") {
        throw new Error(`${key} must be a string`);
    }
    return value;
}

function optionalNumber(
    input: Record<string, unknown>,
    key: string,
): number | undefined {
    const value = input[key];
    if (value === undefined) {
        return undefined;
    }
    if (typeof value !== "number") {
        throw new Error(`${key} must be a number`);
    }
    return value;
}

function requireArray(input: Record<string, unknown>, key: string): unknown[] {
    const value = input[key];
    if (!Array.isArray(value)) {
        throw new Error(`${key} must be an array`);
    }
    return value;
}

type ToolHandler = (input: Record<string, unknown>) => string | Promise<string>;

const BASE_TOOL_HANDLERS: Record<string, ToolHandler> = {
    bash: (input) => runBash(requireString(input, "command")),
    read_file: (input) =>
        runRead(requireString(input, "path"), optionalNumber(input, "limit")),
    write_file: (input) =>
        runWrite(requireString(input, "path"), requireString(input, "content")),
    edit_file: (input) =>
        runEdit(
            requireString(input, "path"),
            requireString(input, "old_text"),
            requireString(input, "new_text"),
        ),
};

const CHILD_TOOL_HANDLERS: Record<string, ToolHandler> = BASE_TOOL_HANDLERS;

const PARENT_TOOL_HANDLERS: Record<string, ToolHandler> = {
    ...BASE_TOOL_HANDLERS,
    todo: (input) => TODO.update(requireArray(input, "items")),
    task: async (input) => {
        const description =
            typeof input.description === "string"
                ? input.description
                : "subtask";
        const prompt = requireString(input, "prompt");
        console.log(`> task (${description}): ${prompt.slice(0, 80)}`);
        return runSubagent(prompt);
    },
};

async function executeToolCalls(
    responseContent: ContentBlock[],
    handlers: Record<string, ToolHandler>,
): Promise<ContentBlock[]> {
    const results: ContentBlock[] = [];

    for (const block of responseContent) {
        if (block.type !== "tool_use") {
            continue;
        }

        const handler = handlers[block.name];
        const toolOutput = handler
            ? await (async () => {
                  try {
                      return await handler(block.input);
                  } catch (error: unknown) {
                      return `Error: ${error instanceof Error ? error.message : String(error)}`;
                  }
              })()
            : `Unknown tool: ${block.name}`;

        if (block.name !== "task") {
            console.log(`> ${block.name}:`);
        }
        console.log(toolOutput.slice(0, 200));

        results.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: toolOutput,
        });
    }

    return results;
}

function stripInternalBlockMetadata(block: ContentBlock): ContentBlock {
    return Object.fromEntries(
        Object.entries(block).filter(([key]) => !key.startsWith("_")),
    ) as ContentBlock;
}

function contentToBlocks(content: string | ContentBlock[]): ContentBlock[] {
    return Array.isArray(content)
        ? content
        : [{ type: "text", text: String(content) }];
}

function normalizeMessages(messages: Message[]): Message[] {
    const cleaned: Message[] = messages.map((message) => {
        const clean: Message = {
            role: message.role,
            content: Array.isArray(message.content)
                ? message.content.map(stripInternalBlockMetadata)
                : message.content,
        };
        if (message.reasoningContent) {
            clean.reasoningContent = message.reasoningContent;
        }
        return clean;
    });

    const existingResults = new Set<string>();
    for (const message of cleaned) {
        if (!Array.isArray(message.content)) {
            continue;
        }
        for (const block of message.content) {
            if (block.type === "tool_result") {
                existingResults.add(block.tool_use_id);
            }
        }
    }

    for (const message of cleaned) {
        if (message.role !== "assistant" || !Array.isArray(message.content)) {
            continue;
        }
        for (const block of message.content) {
            if (block.type === "tool_use" && !existingResults.has(block.id)) {
                cleaned.push({
                    role: "user",
                    content: [
                        {
                            type: "tool_result",
                            tool_use_id: block.id,
                            content: "(cancelled)",
                        },
                    ],
                });
                existingResults.add(block.id);
            }
        }
    }

    const first = cleaned[0];
    if (!first) {
        return cleaned;
    }

    const merged: Message[] = [first];
    for (const message of cleaned.slice(1)) {
        const previous = merged.at(-1);
        if (!previous || previous.role !== message.role) {
            merged.push(message);
            continue;
        }

        previous.content = [
            ...contentToBlocks(previous.content),
            ...contentToBlocks(message.content),
        ];
        if (!previous.reasoningContent && message.reasoningContent) {
            previous.reasoningContent = message.reasoningContent;
        }
    }

    return merged;
}

function contentBlocksToOpenAIMessage(
    message: Message,
): ChatCompletionMessageParam[] {
    if (message.role === "user" && typeof message.content === "string") {
        return [{ role: "user", content: message.content }];
    }

    if (!Array.isArray(message.content)) {
        return [];
    }

    if (message.role === "user") {
        const openAIMessages: ChatCompletionMessageParam[] = [];
        let pendingText: string[] = [];

        const flushText = (): void => {
            if (pendingText.length === 0) {
                return;
            }
            openAIMessages.push({
                role: "user",
                content: pendingText.join("\n"),
            });
            pendingText = [];
        };

        for (const block of message.content) {
            if (block.type === "text") {
                pendingText.push(block.text);
            } else if (block.type === "tool_result") {
                flushText();
                openAIMessages.push({
                    role: "tool",
                    tool_call_id: block.tool_use_id,
                    content: block.content,
                });
            }
        }

        flushText();
        return openAIMessages;
    }

    const text = message.content
        .filter((block): block is TextBlock => block.type === "text")
        .map((block) => block.text)
        .join("\n");
    const toolCalls = message.content
        .filter((block): block is ToolUseBlock => block.type === "tool_use")
        .map(
            (block): ChatCompletionMessageToolCall => ({
                id: block.id,
                type: "function",
                function: {
                    name: block.name,
                    arguments: JSON.stringify(block.input),
                },
            }),
        );

    if (message.role === "assistant") {
        const assistantMessage: AssistantMessageParamWithReasoning = {
            role: "assistant",
            content: text || null,
        };
        if (message.reasoningContent) {
            assistantMessage.reasoning_content = message.reasoningContent;
        }
        if (toolCalls.length > 0) {
            assistantMessage.tool_calls = toolCalls;
        }
        return [assistantMessage];
    }

    return text ? [{ role: "user", content: text }] : [];
}

function toOpenAIMessages(
    messages: Message[],
    system: string,
): ChatCompletionMessageParam[] {
    return [
        {
            role: "system",
            content: system,
        },
        ...normalizeMessages(messages).flatMap(contentBlocksToOpenAIMessage),
    ];
}

function fromOpenAIMessage(message: AssistantMessageWithReasoning): {
    content: ContentBlock[];
    reasoningContent?: string;
} {
    const content: ContentBlock[] = [];

    if (message.content) {
        content.push({ type: "text", text: message.content });
    }

    for (const toolCall of message.tool_calls ?? []) {
        if (toolCall.type !== "function") {
            continue;
        }

        content.push({
            type: "tool_use",
            id: toolCall.id,
            name: toolCall.function.name,
            input: parseToolArguments(toolCall.function.arguments),
        });
    }

    return message.reasoning_content
        ? { content, reasoningContent: message.reasoning_content }
        : { content };
}

async function createMessage(
    messages: Message[],
    options: MessageCreateOptions,
): Promise<ModelResponse> {
    const model = process.env.DEEPSEEK_MODEL_ID || "deepseek-v4-flash";
    const baseURL = process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com";
    const apiKey = process.env.DEEPSEEK_API_KEY;

    if (!apiKey) {
        throw new Error("DEEPSEEK_API_KEY is required");
    }

    const client = new OpenAI({
        apiKey,
        baseURL,
    });

    const response = await client.chat.completions.create({
        model,
        messages: toOpenAIMessages(messages, options.system),
        tools: options.tools,
        tool_choice: "auto",
        max_tokens: DEFAULT_MAX_TOKENS,
    });

    const choice = response.choices[0];
    const message = choice?.message;
    if (!message) {
        throw new Error("DeepSeek API returned no message");
    }

    const parsedMessage = fromOpenAIMessage(message);

    const modelResponse: ModelResponse = {
        content: parsedMessage.content,
        stopReason: choice.finish_reason,
    };
    if (parsedMessage.reasoningContent) {
        modelResponse.reasoningContent = parsedMessage.reasoningContent;
    }

    return modelResponse;
}

async function runSubagent(prompt: string): Promise<string> {
    const subMessages: Message[] = [{ role: "user", content: prompt }];
    let response: ModelResponse | undefined;

    for (let turn = 0; turn < 30; turn += 1) {
        response = await createMessage(subMessages, {
            system: SUBAGENT_SYSTEM,
            tools: CHILD_TOOLS,
        });

        const assistantMessage: Message = {
            role: "assistant",
            content: response.content,
        };
        if (response.reasoningContent) {
            assistantMessage.reasoningContent = response.reasoningContent;
        }
        subMessages.push(assistantMessage);

        if (response.stopReason !== "tool_calls") {
            break;
        }

        const results = await executeToolCalls(
            response.content,
            CHILD_TOOL_HANDLERS,
        );
        if (results.length === 0) {
            break;
        }
        subMessages.push({ role: "user", content: results });
    }

    if (!response) {
        return "(no summary)";
    }

    const summary = response.content
        .filter((block): block is TextBlock => block.type === "text")
        .map((block) => block.text)
        .filter(Boolean)
        .join("\n")
        .trim();

    return summary || "(no summary)";
}

async function runOneTurn(state: LoopState): Promise<boolean> {
    // 走 LLM 调用
    const response = await createMessage(state.messages, {
        system: SYSTEM,
        tools: PARENT_TOOLS,
    });
    // DeepSeek 会回传一个 reasoningContent 字段，要带上
    const assistantMessage: Message = {
        role: "assistant",
        content: response.content,
    };
    if (response.reasoningContent) {
        assistantMessage.reasoningContent = response.reasoningContent;
    }
    state.messages.push(assistantMessage);
    // 如果不需要调用工具，loop 中断
    if (response.stopReason !== "tool_calls") {
        delete state.transitionReason;
        return false;
    }

    // 有工具调用且正常返回，需要把工具的结果塞回去
    const results = await executeToolCalls(
        response.content,
        PARENT_TOOL_HANDLERS,
    );
    if (results.length === 0) {
        delete state.transitionReason;
        return false;
    }

    // 如果用了 todo 工具，那么当前任务列表进度肯定会更新
    if (
        response.content.some(
            (block) => block.type === "tool_use" && block.name === "todo",
        )
    ) {
        TODO.state.roundsSinceUpdate = 0;
    } else {
        // 没有用 todo 的话，才需要去判断是否需要加个提醒
        TODO.noteRoundWithoutUpdate();
        const reminder = TODO.reminder();
        if (reminder) {
            results.push({ type: "text", text: reminder });
        }
    }

    state.messages.push({ role: "user", content: results });
    state.turnCount += 1;
    state.transitionReason = "tool_result";
    return true;
}

async function agentLoop(state: LoopState): Promise<void> {
    while (await runOneTurn(state)) {
        // loop 逻辑在 runOneTurn 函数这里
    }
}

function writeMessageTrace(messages: Message[]): void {
    const payload = {
        updatedAt: new Date().toISOString(),
        messages,
    };
    runWrite(MESSAGE_TRACE_PATH, `${JSON.stringify(payload, null, 2)}\n`);
}

async function readQuery(
    rl: ReturnType<typeof createInterface>,
): Promise<string> {
    const firstLine = await rl.question("\x1b[36ms04 >> \x1b[0m");
    if (firstLine.trim() !== '"""') {
        return firstLine;
    }

    output.write('\x1b[36m... paste text, end with """\x1b[0m\n');
    const lines: string[] = [];
    while (true) {
        const line = await new Promise<string>((resolve) => {
            rl.once("line", resolve);
        });
        if (line.trim() === '"""') {
            return lines.join("\n");
        }
        lines.push(line);
    }
}

async function main(): Promise<void> {
    loadDotEnv();

    const history: Message[] = [];
    const rl = createInterface({ input, output });

    try {
        while (true) {
            const query = await readQuery(rl);
            if (["q", "exit", ""].includes(query.trim().toLowerCase())) {
                break;
            }

            const turnStartIndex = history.length;
            history.push({ role: "user", content: query });
            const state = createInitialState(history);
            await agentLoop(state);
            writeMessageTrace(history);
            console.log("\n----以下是模型的回应----\n");
            const finalText = extractAssistantTexts(
                history.slice(turnStartIndex),
            );
            if (finalText) {
                console.log(finalText);
            }
        }
    } finally {
        rl.close();
    }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    main().catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Error: ${message}`);
        process.exitCode = 1;
    });
}
