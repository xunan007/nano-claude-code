import type { SkillRegistry } from "./skill-registry";

export class PromptBuilder {
    parent(workdir: string, skillRegistry: SkillRegistry): string {
        return `You are a coding agent at ${workdir}.
Use load_skill when a task needs specialized instructions before you act.
${this.skillsCatalog(skillRegistry)}
Use the todo tool for multi-step work.
Use the task tool to delegate focused exploration or subtasks when it keeps the parent context cleaner.
Use compact if the conversation gets too long.
Keep exactly one step in_progress when a task has multiple steps.
Refresh the plan as work advances. Prefer tools over prose.`;
    }

    subagent(workdir: string, skillRegistry: SkillRegistry): string {
        return `You are a coding subagent at ${workdir}.
Use load_skill when a task needs specialized instructions before you act.
${this.skillsCatalog(skillRegistry)}
Complete the given task with the available filesystem tools, then summarize your findings.
Return only the useful final summary.`;
    }

    private skillsCatalog(skillRegistry: SkillRegistry): string {
        return `Skills available:\n${skillRegistry.describeAvailable()}`;
    }
}
