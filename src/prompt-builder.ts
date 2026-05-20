import { existsSync, readFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";

import type { MemoryManager } from "./memory-manager";
import type { SkillRegistry } from "./skill-registry";

export const DYNAMIC_BOUNDARY = "=== DYNAMIC_BOUNDARY ===";

type PromptBuildOptions = {
    workdir: string;
    skillRegistry: SkillRegistry;
    memoryManager?: MemoryManager;
    role: "parent" | "subagent";
};

export class PromptBuilder {
    parent(
        workdir: string,
        skillRegistry: SkillRegistry,
        memoryManager?: MemoryManager,
    ): string {
        return this.build({
            workdir,
            skillRegistry,
            role: "parent",
            ...(memoryManager ? { memoryManager } : {}),
        });
    }

    subagent(
        workdir: string,
        skillRegistry: SkillRegistry,
        memoryManager?: MemoryManager,
    ): string {
        return this.build({
            workdir,
            skillRegistry,
            role: "subagent",
            ...(memoryManager ? { memoryManager } : {}),
        });
    }

    sections(prompt: string): string[] {
        return prompt
            .split(/\r?\n/)
            .filter(
                (line) => line.startsWith("# ") || line === DYNAMIC_BOUNDARY,
            );
    }

    private build(options: PromptBuildOptions): string {
        const sections = [
            this.buildCore(options.workdir, options.role),
            this.buildSkillListing(options.skillRegistry),
            this.buildMemorySection(options.memoryManager),
            this.buildMemoryGuidance(options.memoryManager),
            TASK_GUIDANCE,
            this.buildClaudeMd(options.workdir),
            DYNAMIC_BOUNDARY,
            this.buildDynamicContext(options.workdir),
        ];

        return sections.filter(Boolean).join("\n\n");
    }

    private buildCore(
        workdir: string,
        role: PromptBuildOptions["role"],
    ): string {
        const roleLine =
            role === "parent"
                ? `You are a coding agent operating in ${workdir}.`
                : `You are a coding subagent operating in ${workdir}.`;
        const subagentLine =
            role === "subagent"
                ? "Complete the delegated task with the available filesystem tools, then return only the useful final summary."
                : "Use the task tool to delegate focused exploration or subtasks when it keeps the parent context cleaner.";

        return [
            roleLine,
            "Use the provided tools to explore, read, write, and edit files.",
            "Always verify before assuming. Prefer reading files over guessing.",
            "The user controls permissions. Some tool calls may be denied.",
            "Use load_skill when a task needs specialized instructions before you act.",
            "Use compact if the conversation gets too long.",
            "Use task tools to plan and track durable work graph tasks.",
            "Keep exactly one step in_progress when a task has multiple steps.",
            "Refresh the plan as work advances. Prefer tools over prose.",
            subagentLine,
        ].join("\n");
    }

    private buildSkillListing(skillRegistry: SkillRegistry): string {
        const catalog = skillRegistry.describeAvailable();
        if (!catalog || catalog === "(no skills available)") {
            return "";
        }

        return `# Available skills\n${catalog}`;
    }

    private buildMemorySection(memoryManager?: MemoryManager): string {
        return memoryManager?.loadMemoryPrompt() ?? "";
    }

    private buildMemoryGuidance(memoryManager?: MemoryManager): string {
        return memoryManager ? MEMORY_GUIDANCE : "";
    }

    private buildClaudeMd(workdir: string): string {
        const sources: { label: string; path: string }[] = [
            {
                label: "user global (~/.claude/CLAUDE.md)",
                path: join(homedir(), ".claude", "CLAUDE.md"),
            },
            {
                label: "project root (CLAUDE.md)",
                path: join(workdir, "CLAUDE.md"),
            },
        ];

        const cwd = process.cwd();
        if (cwd !== workdir) {
            sources.push({
                label: `subdir (${cwd}/CLAUDE.md)`,
                path: join(cwd, "CLAUDE.md"),
            });
        }

        const parts = ["# CLAUDE.md instructions"];
        for (const source of sources) {
            if (!existsSync(source.path)) {
                continue;
            }
            const content = readFileSync(source.path, "utf8").trim();
            if (!content) {
                continue;
            }
            parts.push(`## From ${source.label}`);
            parts.push(content);
        }

        return parts.length > 1 ? parts.join("\n\n") : "";
    }

    private buildDynamicContext(workdir: string): string {
        return [
            "# Dynamic context",
            `Current date: ${new Date().toISOString().slice(0, 10)}`,
            `Working directory: ${workdir}`,
            `Model: ${process.env.DEEPSEEK_MODEL_ID || "deepseek-v4-flash"}`,
            `Platform: ${platform()}`,
        ].join("\n");
    }
}

const MEMORY_GUIDANCE = `# Memory guidance
When to save memories:
- User states a preference ("I like tabs", "always use pytest") -> type: user
- User corrects you ("don't do X", "that was wrong because...") -> type: feedback
- You learn a project fact that is not easy to infer from current code alone
  (for example: a rule exists because of compliance, or a legacy module must
  stay untouched for business reasons) -> type: project
- You learn where an external resource lives (ticket board, dashboard, docs URL)
  -> type: reference

When NOT to save:
- Anything easily derivable from code (function signatures, file structure, directory layout)
- Temporary task state (current branch, open PR numbers, current TODOs)
- Secrets or credentials (API keys, passwords)`;

const TASK_GUIDANCE = `# Persistent task guidance
Task records are durable work items stored on disk, not worker processes.
Use task_create/task_update/task_list/task_get to maintain the work graph.
Respect dependency fields:
- blockedBy lists task ids that must finish before this task should proceed.
- blocks lists task ids that this task unlocks later.
- Use addBlocks on a prerequisite task to declare what later tasks it blocks; this also updates the later task's blockedBy list.
- Use addBlockedBy on a blocked task when that is more natural; this also updates the prerequisite task's blocks list.
- Before starting or completing a task, check whether blockedBy is empty.
- After completing a task, list or get affected tasks to verify dependency cleanup.`;
