import {
    BACKOFF_BASE_DELAY_MS,
    BACKOFF_MAX_DELAY_MS,
    CONTINUATION_MESSAGE,
    MAX_RECOVERY_ATTEMPTS,
    WORKDIR,
} from "./config";
import { CompactManager } from "./compact-manager";
import type { HookManager } from "./hook-manager";
import type { MemoryManager } from "./memory-manager";
import type { MessageCodec } from "./message-codec";
import type { ModelClient } from "./model-client";
import type { PromptBuilder } from "./prompt-builder";
import type { SkillRegistry } from "./skill-registry";
import type { TaskManager } from "./task-manager";
import { ToolRuntime } from "./tool-runtime";
import type {
    LoopState,
    Message,
    MessageCreateOptions,
    ModelResponse,
    TextBlock,
    ToolUseBlock,
} from "./types";

type AgentLoopOptions = {
    promptBuilder: PromptBuilder;
    skillRegistry: SkillRegistry;
    messageCodec: MessageCodec;
    modelClient: ModelClient;
    compactManager: CompactManager;
    memoryManager?: MemoryManager;
    taskManager?: TaskManager;
    hookManager?: HookManager;
};

export class AgentLoop {
    private readonly parentRuntime: ToolRuntime;
    private readonly outputRecoveryCounts = new WeakMap<Message[], number>();

    constructor(private readonly options: AgentLoopOptions) {
        this.parentRuntime = new ToolRuntime({
            compactManager: options.compactManager,
            skillRegistry: options.skillRegistry,
            hookManager: options.hookManager,
            runSubagent: (prompt) => this.runSubagent(prompt),
            enableCompactTool: true,
            ...(options.memoryManager
                ? { memoryManager: options.memoryManager }
                : {}),
            ...(options.taskManager
                ? { taskManager: options.taskManager }
                : {}),
        });
    }

    createInitialState(messages: Message[]): LoopState {
        return {
            messages,
            turnCount: 1,
        };
    }

    async run(state: LoopState): Promise<void> {
        while (await this.runOneTurn(state)) {
            // runOneTurn owns each transition.
        }
    }

    parentSystemPrompt(): string {
        return this.options.promptBuilder.parent(
            WORKDIR,
            this.options.skillRegistry,
            this.options.memoryManager,
        );
    }

    systemPromptSections(): string[] {
        return this.options.promptBuilder.sections(this.parentSystemPrompt());
    }

    async runSubagent(prompt: string): Promise<string> {
        const subMessages: Message[] = [{ role: "user", content: prompt }];
        const childCompactManager = new CompactManager(
            this.options.modelClient,
            this.options.messageCodec,
        );
        const childRuntime = new ToolRuntime({
            compactManager: childCompactManager,
            skillRegistry: this.options.skillRegistry,
            hookManager: this.options.hookManager,
            ...(this.options.memoryManager
                ? { memoryManager: this.options.memoryManager }
                : {}),
            ...(this.options.taskManager
                ? { taskManager: this.options.taskManager }
                : {}),
        });
        let response: ModelResponse | undefined;

        for (let turn = 0; turn < 30; turn += 1) {
            response = await this.createMessageWithRecovery(
                subMessages,
                {
                    system: this.options.promptBuilder.subagent(
                        WORKDIR,
                        this.options.skillRegistry,
                        this.options.memoryManager,
                    ),
                    tools: childRuntime.tools,
                },
                childCompactManager,
            );
            if (!response) {
                break;
            }

            const assistantMessage = this.toAssistantMessage(response);
            subMessages.push(assistantMessage);

            if (this.shouldContinueAfterOutputLimit(response, subMessages)) {
                continue;
            }

            if (response.stopReason !== "tool_calls") {
                break;
            }

            const results = await childRuntime.executeToolCalls(
                response.content,
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

    private async runOneTurn(state: LoopState): Promise<boolean> {
        this.options.compactManager.microCompact(state.messages);
        if (this.options.compactManager.shouldCompact(state.messages)) {
            console.log("[auto compact]");
            await this.options.compactManager.compactHistory(state.messages);
        }

        const response = await this.createMessageWithRecovery(
            state.messages,
            {
                system: this.options.promptBuilder.parent(
                    WORKDIR,
                    this.options.skillRegistry,
                    this.options.memoryManager,
                ),
                tools: this.parentRuntime.tools,
            },
            this.options.compactManager,
        );
        if (!response) {
            delete state.transitionReason;
            return false;
        }
        state.messages.push(this.toAssistantMessage(response));

        if (this.shouldContinueAfterOutputLimit(response, state.messages)) {
            state.turnCount += 1;
            state.transitionReason = "tool_result";
            return true;
        }

        if (response.stopReason !== "tool_calls") {
            delete state.transitionReason;
            return false;
        }

        const results = await this.parentRuntime.executeToolCalls(
            response.content,
        );
        if (results.length === 0) {
            delete state.transitionReason;
            return false;
        }

        state.messages.push({ role: "user", content: results });

        const compactBlock = response.content.find(
            (block): block is ToolUseBlock =>
                block.type === "tool_use" && block.name === "compact",
        );
        if (compactBlock) {
            const focus =
                typeof compactBlock.input.focus === "string"
                    ? compactBlock.input.focus
                    : undefined;
            console.log("[manual compact]");
            await this.options.compactManager.compactHistory(
                state.messages,
                focus,
            );
        }

        state.turnCount += 1;
        state.transitionReason = "tool_result";
        return true;
    }

    private async createMessageWithRecovery(
        messages: Message[],
        options: MessageCreateOptions,
        compactManager: CompactManager,
    ): Promise<ModelResponse | undefined> {
        for (let attempt = 0; attempt <= MAX_RECOVERY_ATTEMPTS; attempt += 1) {
            try {
                return await this.options.modelClient.createMessage(
                    messages,
                    options,
                );
            } catch (error: unknown) {
                if (isPromptTooLongError(error)) {
                    console.log(
                        `[Recovery] Prompt too long. Compacting... (attempt ${attempt + 1})`,
                    );
                    await compactManager.compactHistory(
                        messages,
                        "Recover from prompt-too-long API error.",
                    );
                    continue;
                }

                if (
                    isTransientError(error) &&
                    attempt < MAX_RECOVERY_ATTEMPTS
                ) {
                    const delay = backoffDelay(attempt);
                    console.log(
                        `[Recovery] API error: ${formatError(error)}. Retrying in ${(delay / 1000).toFixed(1)}s (attempt ${attempt + 1}/${MAX_RECOVERY_ATTEMPTS})`,
                    );
                    await sleep(delay);
                    continue;
                }

                console.log(
                    `[Error] API call failed after ${attempt} retries: ${formatError(error)}`,
                );
                return undefined;
            }
        }

        console.log("[Error] No response received.");
        return undefined;
    }

    private shouldContinueAfterOutputLimit(
        response: ModelResponse,
        messages: Message[],
    ): boolean {
        if (!isOutputLimitStop(response.stopReason)) {
            this.outputRecoveryCounts.set(messages, 0);
            return false;
        }

        const nextCount = (this.outputRecoveryCounts.get(messages) ?? 0) + 1;
        this.outputRecoveryCounts.set(messages, nextCount);

        if (nextCount > MAX_RECOVERY_ATTEMPTS) {
            console.log(
                `[Error] max_tokens recovery exhausted (${MAX_RECOVERY_ATTEMPTS} attempts). Stopping.`,
            );
            return false;
        }

        console.log(
            `[Recovery] max_tokens hit (${nextCount}/${MAX_RECOVERY_ATTEMPTS}). Injecting continuation...`,
        );
        messages.push({ role: "user", content: CONTINUATION_MESSAGE });
        return true;
    }

    private toAssistantMessage(response: ModelResponse): Message {
        const assistantMessage: Message = {
            role: "assistant",
            content: response.content,
        };
        if (response.reasoningContent) {
            assistantMessage.reasoningContent = response.reasoningContent;
        }
        return assistantMessage;
    }

    private hasToolUse(
        content: ModelResponse["content"],
        name: string,
    ): boolean {
        return content.some(
            (block) => block.type === "tool_use" && block.name === name,
        );
    }
}

function isOutputLimitStop(stopReason: string | null): boolean {
    return stopReason === "length" || stopReason === "max_tokens";
}

function isPromptTooLongError(error: unknown): boolean {
    const message = formatError(error).toLowerCase();
    return (
        message.includes("overlong_prompt") ||
        (message.includes("prompt") && message.includes("long")) ||
        message.includes("context_length") ||
        message.includes("context length") ||
        message.includes("maximum context")
    );
}

function isTransientError(error: unknown): boolean {
    const message = formatError(error).toLowerCase();
    return (
        message.includes("rate limit") ||
        message.includes("429") ||
        message.includes("timeout") ||
        message.includes("timed out") ||
        message.includes("connection") ||
        message.includes("econnreset") ||
        message.includes("econnrefused") ||
        message.includes("socket") ||
        message.includes("network") ||
        message.includes("temporarily unavailable") ||
        message.includes("503") ||
        message.includes("502")
    );
}

function backoffDelay(attempt: number): number {
    const exponential = Math.min(
        BACKOFF_BASE_DELAY_MS * 2 ** attempt,
        BACKOFF_MAX_DELAY_MS,
    );
    return exponential + Math.floor(Math.random() * 1_000);
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
