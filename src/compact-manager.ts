import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";

import {
    CONTEXT_LIMIT,
    KEEP_RECENT_TOOL_RESULTS,
    PERSIST_THRESHOLD,
    PREVIEW_CHARS,
    TOOL_RESULTS_DIR,
    TRANSCRIPT_DIR,
    WORKDIR,
} from "./config";
import type { MessageCodec } from "./message-codec";
import type { ModelClient } from "./model-client";
import type { CompactState, Message, TextBlock } from "./types";

export class CompactManager {
    readonly state: CompactState = {
        hasCompacted: false,
        lastSummary: "",
        recentFiles: [],
    };

    constructor(
        private readonly modelClient: ModelClient,
        private readonly messageCodec: MessageCodec,
    ) {}

    estimateContextSize(messages: Message[]): number {
        return JSON.stringify(messages).length;
    }

    shouldCompact(messages: Message[]): boolean {
        return this.estimateContextSize(messages) > CONTEXT_LIMIT;
    }

    trackRecentFile(path: string): void {
        const existingIndex = this.state.recentFiles.indexOf(path);
        if (existingIndex !== -1) {
            this.state.recentFiles.splice(existingIndex, 1);
        }

        this.state.recentFiles.push(path);
        if (this.state.recentFiles.length > 5) {
            this.state.recentFiles.splice(0, this.state.recentFiles.length - 5);
        }
    }

    persistLargeOutput(toolUseId: string, output: string): string {
        if (output.length <= PERSIST_THRESHOLD) {
            return output;
        }

        mkdirSync(TOOL_RESULTS_DIR, { recursive: true });
        const storedPath = resolve(TOOL_RESULTS_DIR, `${toolUseId}.txt`);
        if (!existsSync(storedPath)) {
            writeFileSync(storedPath, output);
        }

        const relativePath = relative(WORKDIR, storedPath);
        return [
            "<persisted-output>",
            `Full output saved to: ${relativePath}`,
            "Preview:",
            output.slice(0, PREVIEW_CHARS),
            "</persisted-output>",
        ].join("\n");
    }

    microCompact(messages: Message[]): void {
        const toolResults = this.messageCodec.collectToolResultBlocks(messages);
        if (toolResults.length <= KEEP_RECENT_TOOL_RESULTS) {
            return;
        }

        for (const block of toolResults.slice(0, -KEEP_RECENT_TOOL_RESULTS)) {
            if (block.content.length <= 120) {
                continue;
            }
            block.content =
                "[Earlier tool result compacted. Re-run the tool if you need full detail.]";
        }
    }

    async compactHistory(messages: Message[], focus?: string): Promise<void> {
        const transcriptPath = this.writeTranscript(messages);
        console.log(`[transcript saved: ${relative(WORKDIR, transcriptPath)}]`);

        const summaryParts = [await this.summarizeHistorySafely(messages)];
        if (focus) {
            summaryParts.push(`Focus to preserve next: ${focus}`);
        }
        if (this.state.recentFiles.length > 0) {
            summaryParts.push(
                [
                    "Recent files to reopen if needed:",
                    ...this.state.recentFiles.map((path) => `- ${path}`),
                ].join("\n"),
            );
        }

        const summary = summaryParts.join("\n\n");
        this.state.hasCompacted = true;
        this.state.lastSummary = summary;
        messages.splice(0, messages.length, {
            role: "user",
            content: [
                "This session continues from a previous conversation that was compacted.",
                `Summary of prior context:\n\n${summary}`,
                "Continue from where we left off without re-asking the user.",
            ].join("\n\n"),
        });
    }

    private writeTranscript(messages: Message[]): string {
        mkdirSync(TRANSCRIPT_DIR, { recursive: true });
        const path = resolve(TRANSCRIPT_DIR, `transcript_${Date.now()}.jsonl`);
        const lines = messages
            .map((message) => JSON.stringify(message))
            .join("\n");
        writeFileSync(path, `${lines}\n`);
        return path;
    }

    private async summarizeHistory(messages: Message[]): Promise<string> {
        const conversation = JSON.stringify(messages).slice(0, 80_000);
        const prompt = [
            "Summarize this coding-agent conversation so work can continue.",
            "Preserve:",
            "1. The current goal",
            "2. Important findings and decisions",
            "3. Files read or changed",
            "4. Remaining work",
            "5. User constraints and preferences",
            "Be compact but concrete.",
            "",
            conversation,
        ].join("\n");

        const response = await this.modelClient.createMessage(
            [{ role: "user", content: prompt }],
            {
                system: "You summarize coding-agent conversations for context compaction.",
            },
        );
        const summary = response.content
            .filter((block): block is TextBlock => block.type === "text")
            .map((block) => block.text)
            .filter(Boolean)
            .join("\n")
            .trim();

        return summary || "(summary unavailable)";
    }

    private async summarizeHistorySafely(messages: Message[]): Promise<string> {
        try {
            return await this.summarizeHistory(messages);
        } catch (error: unknown) {
            const message =
                error instanceof Error ? error.message : String(error);
            return `(compact failed: ${message}). Previous context lost.`;
        }
    }
}
