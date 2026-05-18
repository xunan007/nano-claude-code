import OpenAI from "openai";

import { DEFAULT_MAX_TOKENS } from "./config";
import type { MessageCodec } from "./message-codec";
import type { Message, MessageCreateOptions, ModelResponse } from "./types";

export class ModelClient {
    constructor(private readonly messageCodec: MessageCodec) {}

    async createMessage(
        messages: Message[],
        options: MessageCreateOptions,
    ): Promise<ModelResponse> {
        const model = process.env.DEEPSEEK_MODEL_ID || "deepseek-v4-flash";
        const baseURL =
            process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com";
        const apiKey = process.env.DEEPSEEK_API_KEY;

        if (!apiKey) {
            throw new Error("DEEPSEEK_API_KEY is required");
        }

        const client = new OpenAI({
            apiKey,
            baseURL,
        });

        const request = {
            model,
            messages: this.messageCodec.toOpenAIMessages(
                messages,
                options.system,
            ),
            max_tokens: DEFAULT_MAX_TOKENS,
            ...(options.tools && options.tools.length > 0
                ? { tools: options.tools, tool_choice: "auto" as const }
                : {}),
        };

        const response = await client.chat.completions.create(request);
        const choice = response.choices[0];
        const message = choice?.message;
        if (!message) {
            throw new Error("DeepSeek API returned no message");
        }

        const parsedMessage = this.messageCodec.fromOpenAIMessage(message);
        const modelResponse: ModelResponse = {
            content: parsedMessage.content,
            stopReason: choice.finish_reason,
        };
        if (parsedMessage.reasoningContent) {
            modelResponse.reasoningContent = parsedMessage.reasoningContent;
        }

        return modelResponse;
    }
}
