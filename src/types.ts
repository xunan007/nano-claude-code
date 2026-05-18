import type { ChatCompletionTool } from "openai/resources/chat/completions";

export type Role = "user" | "assistant";

export type TextBlock = {
    type: "text";
    text: string;
};

export type ToolUseBlock = {
    type: "tool_use";
    id: string;
    name: string;
    input: Record<string, unknown>;
};

export type ToolResultBlock = {
    type: "tool_result";
    tool_use_id: string;
    content: string;
};

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;

export type Message = {
    role: Role;
    content: string | ContentBlock[];
    reasoningContent?: string;
};

export type ModelResponse = {
    content: ContentBlock[];
    stopReason: string | null;
    reasoningContent?: string;
};

export type MessageCreateOptions = {
    system: string;
    tools?: ChatCompletionTool[];
};

export type PlanStatus = "pending" | "in_progress" | "completed";

export type PlanItem = {
    content: string;
    status: PlanStatus;
    activeForm: string;
};

export type PlanningState = {
    items: PlanItem[];
    roundsSinceUpdate: number;
};

export type SkillManifest = {
    name: string;
    description: string;
    path: string;
};

export type SkillDocument = {
    manifest: SkillManifest;
    body: string;
};

export type CompactState = {
    hasCompacted: boolean;
    lastSummary: string;
    recentFiles: string[];
};

export type LoopState = {
    messages: Message[];
    turnCount: number;
    transitionReason?: "tool_result";
};
