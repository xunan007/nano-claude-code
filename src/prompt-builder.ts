import type { MemoryManager } from "./memory-manager";
import type { SkillRegistry } from "./skill-registry";

export class PromptBuilder {
    parent(
        workdir: string,
        skillRegistry: SkillRegistry,
        memoryManager?: MemoryManager,
    ): string {
        return [
            `You are a coding agent at ${workdir}.
The user controls permissions. Some tool calls may be denied.
Use load_skill when a task needs specialized instructions before you act.
${this.skillsCatalog(skillRegistry)}
Use the todo tool for multi-step work.
Use the task tool to delegate focused exploration or subtasks when it keeps the parent context cleaner.
Use compact if the conversation gets too long.
Keep exactly one step in_progress when a task has multiple steps.
Refresh the plan as work advances. Prefer tools over prose.`,
            this.memorySection(memoryManager),
            MEMORY_GUIDANCE,
        ]
            .filter(Boolean)
            .join("\n\n");
    }

    subagent(
        workdir: string,
        skillRegistry: SkillRegistry,
        memoryManager?: MemoryManager,
    ): string {
        return [
            `You are a coding subagent at ${workdir}.
The user controls permissions. Some tool calls may be denied.
Use load_skill when a task needs specialized instructions before you act.
${this.skillsCatalog(skillRegistry)}
Complete the given task with the available filesystem tools, then summarize your findings.
Return only the useful final summary.`,
            this.memorySection(memoryManager),
            MEMORY_GUIDANCE,
        ]
            .filter(Boolean)
            .join("\n\n");
    }

    private skillsCatalog(skillRegistry: SkillRegistry): string {
        return `Skills available:\n${skillRegistry.describeAvailable()}`;
    }

    private memorySection(memoryManager?: MemoryManager): string {
        return memoryManager?.loadMemoryPrompt() ?? "";
    }
}

const MEMORY_GUIDANCE = `When to save memories:
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
