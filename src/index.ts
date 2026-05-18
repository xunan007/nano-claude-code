#!/usr/bin/env node

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

import { config as loadEnvFile } from "dotenv";

import { AgentLoop } from "./agent-loop";
import { MESSAGE_TRACE_PATH, SKILLS_DIR, WORKDIR } from "./config";
import { CompactManager } from "./compact-manager";
import { MessageCodec } from "./message-codec";
import { ModelClient } from "./model-client";
import { PromptBuilder } from "./prompt-builder";
import { SkillRegistry } from "./skill-registry";
import { TodoManager } from "./todo-manager";
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
    const firstLine = await rl.question("\x1b[36ms06 >> \x1b[0m");
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

function createAgentLoop(): {
    agentLoop: AgentLoop;
    messageCodec: MessageCodec;
} {
    const messageCodec = new MessageCodec();
    const modelClient = new ModelClient(messageCodec);
    const compactManager = new CompactManager(modelClient, messageCodec);
    const skillRegistry = new SkillRegistry(SKILLS_DIR);
    const todoManager = new TodoManager();
    const promptBuilder = new PromptBuilder();
    const agentLoop = new AgentLoop({
        promptBuilder,
        skillRegistry,
        todoManager,
        messageCodec,
        modelClient,
        compactManager,
    });

    return { agentLoop, messageCodec };
}

async function main(): Promise<void> {
    loadDotEnv();

    const history: Message[] = [];
    const { agentLoop, messageCodec } = createAgentLoop();
    const rl = createInterface({ input, output });

    try {
        while (true) {
            const query = await readQuery(rl);
            if (["q", "exit", ""].includes(query.trim().toLowerCase())) {
                break;
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
