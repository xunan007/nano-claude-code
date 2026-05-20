#!/usr/bin/env node

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

import { config as loadEnvFile } from "dotenv";

import { AgentLoop } from "./agent-loop";
import { BackgroundManager } from "./background-manager";
import { MESSAGE_TRACE_PATH, SKILLS_DIR, WORKDIR } from "./config";
import { CompactManager } from "./compact-manager";
import { HookManager } from "./hook-manager";
import { MemoryManager } from "./memory-manager";
import { MessageCodec } from "./message-codec";
import { ModelClient } from "./model-client";
import {
    handlePermissionCommand,
    installPermissionSystem,
} from "./permission-cli";
import { PromptBuilder } from "./prompt-builder";
import { SkillRegistry } from "./skill-registry";
import { TaskManager } from "./task-manager";
import type { Message } from "./types";

function loadDotEnv(path = ".env"): void {
    loadEnvFile({ path, override: true, quiet: true });
}

function writeMessageTrace(messages: Message[]): void {
    const payload = {
        updatedAt: new Date().toISOString(),
        messages,
    };
    const path = resolve(WORKDIR, MESSAGE_TRACE_PATH);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`);
}

async function readQuery(
    rl: ReturnType<typeof createInterface>,
): Promise<string> {
    const firstLine = await rl.question("\x1b[36ms13 >> \x1b[0m");
    if (firstLine.trim() !== '"""') {
        return firstLine;
    }

    output.write('\x1b[36m... paste text, end with """\x1b[0m\n');
    const lines: string[] = [];
    while (true) {
        const line = await new Promise<string>((resolveLine) => {
            rl.once("line", resolveLine);
        });
        if (line.trim() === '"""') {
            return lines.join("\n");
        }
        lines.push(line);
    }
}

function createAgentLoop(
    hookManager: HookManager,
    memoryManager: MemoryManager,
    taskManager: TaskManager,
    backgroundManager: BackgroundManager,
): {
    agentLoop: AgentLoop;
    messageCodec: MessageCodec;
} {
    const messageCodec = new MessageCodec();
    const modelClient = new ModelClient(messageCodec);
    const compactManager = new CompactManager(modelClient, messageCodec);
    const skillRegistry = new SkillRegistry(SKILLS_DIR);
    const promptBuilder = new PromptBuilder();
    const agentLoop = new AgentLoop({
        promptBuilder,
        skillRegistry,
        messageCodec,
        modelClient,
        compactManager,
        backgroundManager,
        memoryManager,
        taskManager,
        hookManager,
    });

    return { agentLoop, messageCodec };
}

async function main(): Promise<void> {
    loadDotEnv();

    const memoryManager = new MemoryManager();
    memoryManager.loadAll();
    if (memoryManager.count() > 0) {
        console.log(`[${memoryManager.count()} memories loaded into context]`);
    } else {
        console.log(
            "[No existing memories. The agent can create them with save_memory.]",
        );
    }

    const history: Message[] = [];
    const backgroundManager = new BackgroundManager();
    const taskManager = new TaskManager();
    const rl = createInterface({ input, output });

    try {
        const hookManager = new HookManager();
        const permissionManager = await installPermissionSystem(
            rl,
            hookManager,
        );
        const { agentLoop, messageCodec } = createAgentLoop(
            hookManager,
            memoryManager,
            taskManager,
            backgroundManager,
        );
        const fullPrompt = agentLoop.parentSystemPrompt();
        console.log(
            `[System prompt assembled: ${fullPrompt.length} chars, ~${agentLoop.systemPromptSections().length} sections]`,
        );
        console.log("[Persistent tasks enabled: .tasks/task_<id>.json]");
        console.log("[Background tasks enabled: .runtime-tasks/<id>.json]");
        console.log(
            "[Error recovery enabled: max_tokens / prompt_too_long / connection backoff]",
        );
        const sessionStartResult = await hookManager.runHooks("SessionStart", {
            source: "startup",
        });
        for (const message of sessionStartResult.messages ?? []) {
            history.push({
                role: "user",
                content: `[Hook message]: ${message}`,
            });
        }
        while (true) {
            const query = await readQuery(rl);
            if (["q", "exit", ""].includes(query.trim().toLowerCase())) {
                break;
            }
            if (query.trim() === "/memories") {
                const memories = memoryManager.list();
                if (memories.length > 0) {
                    for (const memory of memories) {
                        console.log(memory);
                    }
                } else {
                    console.log("  (no memories)");
                }
                continue;
            }
            if (query.trim() === "/prompt") {
                console.log("--- System Prompt ---");
                console.log(agentLoop.parentSystemPrompt());
                console.log("--- End ---");
                continue;
            }
            if (query.trim() === "/sections") {
                for (const section of agentLoop.systemPromptSections()) {
                    console.log(`  ${section}`);
                }
                continue;
            }
            if (handlePermissionCommand(query, permissionManager)) {
                continue;
            }

            const turnStartIndex = history.length;
            history.push({ role: "user", content: query });
            const state = agentLoop.createInitialState(history);
            await agentLoop.run(state);
            writeMessageTrace(history);
            console.log("\n----以下是模型的回应----\n");
            const finalStartIndex = Math.min(
                turnStartIndex,
                Math.max(history.length - 1, 0),
            );
            const finalText = messageCodec.extractAssistantTexts(
                history.slice(finalStartIndex),
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
