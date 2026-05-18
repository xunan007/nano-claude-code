import { WORKDIR } from "./config";
import { CompactManager } from "./compact-manager";
import type { MessageCodec } from "./message-codec";
import type { ModelClient } from "./model-client";
import type { PromptBuilder } from "./prompt-builder";
import type { SkillRegistry } from "./skill-registry";
import type { TodoManager } from "./todo-manager";
import { ToolRuntime } from "./tool-runtime";
import type {
    LoopState,
    Message,
    ModelResponse,
    TextBlock,
    ToolUseBlock,
} from "./types";

type AgentLoopOptions = {
    promptBuilder: PromptBuilder;
    skillRegistry: SkillRegistry;
    todoManager: TodoManager;
    messageCodec: MessageCodec;
    modelClient: ModelClient;
    compactManager: CompactManager;
};

export class AgentLoop {
    private readonly parentRuntime: ToolRuntime;

    constructor(private readonly options: AgentLoopOptions) {
        this.parentRuntime = new ToolRuntime({
            compactManager: options.compactManager,
            skillRegistry: options.skillRegistry,
            todoManager: options.todoManager,
            runSubagent: (prompt) => this.runSubagent(prompt),
            enableCompactTool: true,
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

    async runSubagent(prompt: string): Promise<string> {
        const subMessages: Message[] = [{ role: "user", content: prompt }];
        const childCompactManager = new CompactManager(
            this.options.modelClient,
            this.options.messageCodec,
        );
        const childRuntime = new ToolRuntime({
            compactManager: childCompactManager,
            skillRegistry: this.options.skillRegistry,
        });
        let response: ModelResponse | undefined;

        for (let turn = 0; turn < 30; turn += 1) {
            response = await this.options.modelClient.createMessage(
                subMessages,
                {
                    system: this.options.promptBuilder.subagent(
                        WORKDIR,
                        this.options.skillRegistry,
                    ),
                    tools: childRuntime.tools,
                },
            );

            const assistantMessage = this.toAssistantMessage(response);
            subMessages.push(assistantMessage);

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

        const response = await this.options.modelClient.createMessage(
            state.messages,
            {
                system: this.options.promptBuilder.parent(
                    WORKDIR,
                    this.options.skillRegistry,
                ),
                tools: this.parentRuntime.tools,
            },
        );
        state.messages.push(this.toAssistantMessage(response));

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

        // 插入 todo 工具逻辑：开启 todo 之后需要及时检查一下任务清单是否更新
            const reminder =
                this.options.todoManager.noteToolRoundWithoutTodoUpdate(!this.hasToolUse(response.content, "todo"));
            if (reminder) {
                results.push({ type: "text", text: reminder });
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
