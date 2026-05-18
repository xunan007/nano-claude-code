import { resolve } from "node:path";

export const DEFAULT_MAX_TOKENS = 8000;
export const BASH_TIMEOUT_MS = 120_000;
export const WORKDIR = process.cwd();
export const SKILLS_DIR = resolve(WORKDIR, ".skills");
export const PLAN_REMINDER_INTERVAL = 3;
export const CONTEXT_LIMIT = 50_000;
export const KEEP_RECENT_TOOL_RESULTS = 3;
export const PERSIST_THRESHOLD = 30_000;
export const PREVIEW_CHARS = 2_000;
export const TRANSCRIPT_DIR = resolve(WORKDIR, ".transcripts");
export const TOOL_RESULTS_DIR = resolve(
    WORKDIR,
    ".task_outputs",
    "tool-results",
);

export function formatLocalTimestamp(date = new Date()): string {
    const pad = (value: number, length = 2): string =>
        String(value).padStart(length, "0");

    return [
        date.getFullYear(),
        "-",
        pad(date.getMonth() + 1),
        "-",
        pad(date.getDate()),
        "T",
        pad(date.getHours()),
        "-",
        pad(date.getMinutes()),
        "-",
        pad(date.getSeconds()),
        ".",
        pad(date.getMilliseconds(), 3),
    ].join("");
}

export const MESSAGE_TRACE_PATH = `.debug/messages-${formatLocalTimestamp()}.json`;
