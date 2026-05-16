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
const SYSTEM = `You are a coding agent at ${WORKDIR}. Use tools to solve tasks. Act, don't explain.`;

// 界定哪些操作是安全的
export const CONCURRENCY_SAFE = new Set(["read_file"]);
export const CONCURRENCY_UNSAFE = new Set(["write_file", "edit_file"]);

const TOOLS: ChatCompletionTool[] = [
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

export function getStartupMessage(): string {
    return "nano-claude-code TypeScript runtime is ready.";
}

export function loadDotEnv(path = ".env"): void {
    loadEnvFile({ path, override: true, quiet: true });
}

export function createInitialState(messages: Message[]): LoopState {
    return {
        messages,
        turnCount: 1,
    };
}

// 防止路径逃逸
function safePath(path: string): string {
    const resolved = resolve(WORKDIR, path);
    const rel = relative(WORKDIR, resolved);
    if (rel.startsWith("..") || isAbsolute(rel)) {
        throw new Error(`Path escapes workspace: ${path}`);
    }
    return resolved;
}

export function runBash(command: string): string {
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

export function runRead(path: string, limit?: number): string {
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

export function runWrite(path: string, content: string): string {
    try {
        const resolvedPath = safePath(path);
        mkdirSync(dirname(resolvedPath), { recursive: true });
        writeFileSync(resolvedPath, content);
        return `Wrote ${content.length} bytes to ${path}`;
    } catch (error: unknown) {
        return `Error: ${error instanceof Error ? error.message : String(error)}`;
    }
}

export function runEdit(
    path: string,
    oldText: string,
    newText: string,
): string {
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
export function extractText(message: Message): string {
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

type ToolHandler = (input: Record<string, unknown>) => string;

const TOOL_HANDLERS: Record<string, ToolHandler> = {
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

export function executeToolCalls(
    responseContent: ContentBlock[],
): ToolResultBlock[] {
    const results: ToolResultBlock[] = [];

    for (const block of responseContent) {
        if (block.type !== "tool_use") {
            continue;
        }

        const handler = TOOL_HANDLERS[block.name];
        const toolOutput = handler
            ? (() => {
                  try {
                      return handler(block.input);
                  } catch (error: unknown) {
                      return `Error: ${error instanceof Error ? error.message : String(error)}`;
                  }
              })()
            : `Unknown tool: ${block.name}`;

        console.log(`> ${block.name}:`);
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

export function normalizeMessages(messages: Message[]): Message[] {
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

function toOpenAIMessages(messages: Message[]): ChatCompletionMessageParam[] {
    return [
        {
            role: "system",
            content: SYSTEM,
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

async function createMessage(messages: Message[]): Promise<ModelResponse> {
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
        messages: toOpenAIMessages(messages),
        tools: TOOLS,
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

export async function runOneTurn(state: LoopState): Promise<boolean> {
    // 走 LLM 调用
    const response = await createMessage(state.messages);
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
    const results = executeToolCalls(response.content);
    if (results.length === 0) {
        delete state.transitionReason;
        return false;
    }

    state.messages.push({ role: "user", content: results });
    state.turnCount += 1;
    state.transitionReason = "tool_result";
    return true;
}

export async function agentLoop(state: LoopState): Promise<void> {
    while (await runOneTurn(state)) {
        // loop 逻辑在 runOneTurn 函数这里
    }
}

async function main(): Promise<void> {
    loadDotEnv();

    const history: Message[] = [];
    const rl = createInterface({ input, output });

    try {
        while (true) {
            const query = await rl.question("\x1b[36ms02 >> \x1b[0m");
            if (["q", "exit", ""].includes(query.trim().toLowerCase())) {
                break;
            }

            history.push({ role: "user", content: query });
            const state = createInitialState(history);
            await agentLoop(state);

            const finalMessage = history.at(-1);
            const finalText = finalMessage ? extractText(finalMessage) : "";
            if (finalText) {
                console.log(finalText);
            }
            console.log();
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
