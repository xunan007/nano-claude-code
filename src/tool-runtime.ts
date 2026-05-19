import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";

import type { ChatCompletionTool } from "openai/resources/chat/completions";

import { BASH_TIMEOUT_MS, WORKDIR } from "./config";
import type { CompactManager } from "./compact-manager";
import type { PermissionManager } from "./permission-manager";
import type { SkillRegistry } from "./skill-registry";
import type { TodoManager } from "./todo-manager";
import type { ContentBlock } from "./types";

type ToolHandler = (
    input: Record<string, unknown>,
    toolUseId: string,
) => string | Promise<string>;

type ToolEntry = {
    definition: ChatCompletionTool;
    handler: ToolHandler;
};

type ToolRuntimeOptions = {
    compactManager: CompactManager;
    skillRegistry: SkillRegistry;
    permissionManager?: PermissionManager | undefined;
    todoManager?: TodoManager;
    runSubagent?: (prompt: string) => Promise<string>;
    enableCompactTool?: boolean;
};

const FILE_TOOL_DEFINITIONS: ChatCompletionTool[] = [
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
    {
        type: "function",
        function: {
            name: "load_skill",
            description: "Load the full body of a named skill into context.",
            parameters: {
                type: "object",
                properties: {
                    name: { type: "string" },
                },
                required: ["name"],
                additionalProperties: false,
            },
        },
    },
];

const TODO_TOOL_DEFINITION: ChatCompletionTool = {
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

const TASK_TOOL_DEFINITION: ChatCompletionTool = {
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

const COMPACT_TOOL_DEFINITION: ChatCompletionTool = {
    type: "function",
    function: {
        name: "compact",
        description:
            "Summarize earlier conversation so work can continue in a smaller context.",
        parameters: {
            type: "object",
            properties: {
                focus: {
                    type: "string",
                    description: "Optional detail to preserve in the summary.",
                },
            },
            additionalProperties: false,
        },
    },
};

export class ToolRuntime {
    private readonly entries = new Map<string, ToolEntry>();

    constructor(private readonly options: ToolRuntimeOptions) {
        this.registerBaseTools();
        if (options.todoManager) {
            this.register(
                TODO_TOOL_DEFINITION,
                (input) =>
                    options.todoManager?.update(requireArray(input, "items")) ??
                    "No todo manager configured",
            );
        }
        if (options.runSubagent) {
            this.register(TASK_TOOL_DEFINITION, async (input) => {
                const description =
                    typeof input.description === "string"
                        ? input.description
                        : "subtask";
                const prompt = requireString(input, "prompt");
                console.log(`> task (${description}): ${prompt.slice(0, 80)}`);
                return options.runSubagent?.(prompt) ?? "(no subagent)";
            });
        }
        if (options.enableCompactTool) {
            this.register(
                COMPACT_TOOL_DEFINITION,
                () => "Compacting conversation...",
            );
        }
    }

    get tools(): ChatCompletionTool[] {
        return [...this.entries.values()].map((entry) => entry.definition);
    }

    hasTool(name: string): boolean {
        return this.entries.has(name);
    }

    async executeToolCalls(
        responseContent: ContentBlock[],
    ): Promise<ContentBlock[]> {
        const results: ContentBlock[] = [];

        for (const block of responseContent) {
            if (block.type !== "tool_use") {
                continue;
            }

            const permissionManager = this.options.permissionManager;
            const decision = permissionManager?.check(block.name, block.input);
            if (decision?.behavior === "deny") {
                const output = `Permission denied: ${decision.reason}`;
                console.log(`  [DENIED] ${block.name}: ${decision.reason}`);
                results.push({
                    type: "tool_result",
                    tool_use_id: block.id,
                    content: output,
                });
                continue;
            }

            if (decision?.behavior === "ask") {
                const approved = await permissionManager?.askUser(
                    block.name,
                    block.input,
                );
                if (!approved) {
                    const output = `Permission denied by user for ${block.name}`;
                    console.log(`  [USER DENIED] ${block.name}`);
                    if (
                        permissionManager &&
                        permissionManager.consecutiveDenials >=
                            permissionManager.maxConsecutiveDenials
                    ) {
                        console.log(
                            `  [${permissionManager.consecutiveDenials} consecutive denials -- consider switching to plan mode]`,
                        );
                    }
                    results.push({
                        type: "tool_result",
                        tool_use_id: block.id,
                        content: output,
                    });
                    continue;
                }
            }

            const entry = this.entries.get(block.name);
            const handlerResult = entry
                ? await (async () => {
                      try {
                          return await entry.handler(block.input, block.id);
                      } catch (error: unknown) {
                          return `Error: ${
                              error instanceof Error
                                  ? error.message
                                  : String(error)
                          }`;
                      }
                  })()
                : `Unknown tool: ${block.name}`;

            if (block.name !== "task") {
                console.log(`> ${block.name}:`);
            }
            console.log(handlerResult.slice(0, 200));

            results.push({
                type: "tool_result",
                tool_use_id: block.id,
                content: handlerResult,
            });
        }

        return results;
    }

    private registerBaseTools(): void {
        this.register(FILE_TOOL_DEFINITIONS[0]!, (input, toolUseId) =>
            this.runBash(requireString(input, "command"), toolUseId),
        );
        this.register(FILE_TOOL_DEFINITIONS[1]!, (input, toolUseId) =>
            this.runRead(
                requireString(input, "path"),
                toolUseId,
                optionalNumber(input, "limit"),
            ),
        );
        this.register(FILE_TOOL_DEFINITIONS[2]!, (input) =>
            this.runWrite(
                requireString(input, "path"),
                requireString(input, "content"),
            ),
        );
        this.register(FILE_TOOL_DEFINITIONS[3]!, (input) =>
            this.runEdit(
                requireString(input, "path"),
                requireString(input, "old_text"),
                requireString(input, "new_text"),
            ),
        );
        this.register(FILE_TOOL_DEFINITIONS[4]!, (input) =>
            this.options.skillRegistry.loadFullText(
                requireString(input, "name"),
            ),
        );
    }

    private register(
        definition: ChatCompletionTool,
        handler: ToolHandler,
    ): void {
        if (definition.type !== "function") {
            throw new Error("Only function tools are supported");
        }
        this.entries.set(definition.function.name, { definition, handler });
    }

    private safePath(path: string): string {
        const resolved = resolve(WORKDIR, path);
        const rel = relative(WORKDIR, resolved);
        if (rel.startsWith("..") || isAbsolute(rel)) {
            throw new Error(`Path escapes workspace: ${path}`);
        }
        return resolved;
    }

    private runBash(command: string, toolUseId: string): string {
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
        const combined = `${stdout}${stderr}`.trim() || "(no output)";
        return this.options.compactManager.persistLargeOutput(
            toolUseId,
            combined,
        );
    }

    private runRead(path: string, toolUseId: string, limit?: number): string {
        try {
            this.options.compactManager.trackRecentFile(path);
            const text = readFileSync(this.safePath(path), "utf8");
            const lines = text.split(/\r?\n/);
            const limitedLines =
                limit !== undefined && limit < lines.length
                    ? [
                          ...lines.slice(0, limit),
                          `... (${lines.length - limit} more lines)`,
                      ]
                    : lines;
            return this.options.compactManager.persistLargeOutput(
                toolUseId,
                limitedLines.join("\n"),
            );
        } catch (error: unknown) {
            return `Error: ${error instanceof Error ? error.message : String(error)}`;
        }
    }

    private runWrite(path: string, content: string): string {
        try {
            const resolvedPath = this.safePath(path);
            mkdirSync(dirname(resolvedPath), { recursive: true });
            writeFileSync(resolvedPath, content);
            return `Wrote ${content.length} bytes to ${path}`;
        } catch (error: unknown) {
            return `Error: ${error instanceof Error ? error.message : String(error)}`;
        }
    }

    private runEdit(path: string, oldText: string, newText: string): string {
        try {
            const resolvedPath = this.safePath(path);
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
