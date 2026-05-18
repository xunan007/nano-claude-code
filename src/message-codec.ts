import type {
    ChatCompletionAssistantMessageParam,
    ChatCompletionMessageParam,
    ChatCompletionMessageToolCall,
} from "openai/resources/chat/completions";

import type {
    ContentBlock,
    Message,
    TextBlock,
    ToolResultBlock,
} from "./types";

type AssistantMessageWithReasoning = {
    content: string | null;
    reasoning_content?: string;
    tool_calls?: ChatCompletionMessageToolCall[];
};

type AssistantMessageParamWithReasoning =
    ChatCompletionAssistantMessageParam & {
        reasoning_content?: string;
    };

export class MessageCodec {
    extractText(message: Message): string {
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

    extractAssistantTexts(messages: Message[]): string {
        return messages
            .filter((message) => message.role === "assistant")
            .map((message) => this.extractText(message))
            .filter(Boolean)
            .join("\n\n")
            .trim();
    }

    toOpenAIMessages(
        messages: Message[],
        system: string,
    ): ChatCompletionMessageParam[] {
        return [
            {
                role: "system",
                content: system,
            },
            ...this.normalizeMessages(messages).flatMap((message) =>
                this.contentBlocksToOpenAIMessage(message),
            ),
        ];
    }

    fromOpenAIMessage(message: AssistantMessageWithReasoning): {
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
                input: this.parseToolArguments(toolCall.function.arguments),
            });
        }

        return message.reasoning_content
            ? { content, reasoningContent: message.reasoning_content }
            : { content };
    }

    collectToolResultBlocks(messages: Message[]): ToolResultBlock[] {
        const blocks: ToolResultBlock[] = [];

        for (const message of messages) {
            if (message.role !== "user" || !Array.isArray(message.content)) {
                continue;
            }

            for (const block of message.content) {
                if (block.type === "tool_result") {
                    blocks.push(block);
                }
            }
        }

        return blocks;
    }

    private stripInternalBlockMetadata(block: ContentBlock): ContentBlock {
        return Object.fromEntries(
            Object.entries(block).filter(([key]) => !key.startsWith("_")),
        ) as ContentBlock;
    }

    private contentToBlocks(content: string | ContentBlock[]): ContentBlock[] {
        return Array.isArray(content)
            ? content
            : [{ type: "text", text: String(content) }];
    }

    private normalizeMessages(messages: Message[]): Message[] {
        const cleaned: Message[] = messages.map((message) => {
            const clean: Message = {
                role: message.role,
                content: Array.isArray(message.content)
                    ? message.content.map((block) =>
                          this.stripInternalBlockMetadata(block),
                      )
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
            if (
                message.role !== "assistant" ||
                !Array.isArray(message.content)
            ) {
                continue;
            }
            for (const block of message.content) {
                if (
                    block.type === "tool_use" &&
                    !existingResults.has(block.id)
                ) {
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
                ...this.contentToBlocks(previous.content),
                ...this.contentToBlocks(message.content),
            ];
            if (!previous.reasoningContent && message.reasoningContent) {
                previous.reasoningContent = message.reasoningContent;
            }
        }

        return merged;
    }

    private contentBlocksToOpenAIMessage(
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
            .filter((block) => block.type === "tool_use")
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

    private parseToolArguments(args: string): Record<string, unknown> {
        try {
            const parsed = JSON.parse(args) as unknown;
            return parsed &&
                typeof parsed === "object" &&
                !Array.isArray(parsed)
                ? (parsed as Record<string, unknown>)
                : {};
        } catch {
            return {};
        }
    }
}
