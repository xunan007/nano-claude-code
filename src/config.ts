import { resolve } from "node:path";

export const DEFAULT_MAX_TOKENS = 8000;
export const BASH_TIMEOUT_MS = 120_000;
export const MAX_RECOVERY_ATTEMPTS = 3;
export const BACKOFF_BASE_DELAY_MS = 1_000;
export const BACKOFF_MAX_DELAY_MS = 30_000;
export const CONTINUATION_MESSAGE =
    "Output limit hit. Continue directly from where you stopped -- no recap, no repetition. Pick up mid-sentence if needed.";
export const WORKDIR = process.cwd();
export const SKILLS_DIR = resolve(WORKDIR, ".skills");
export const MEMORY_DIR = resolve(WORKDIR, ".memory");
export const MEMORY_INDEX = resolve(MEMORY_DIR, "MEMORY.md");
export const TASKS_DIR = resolve(WORKDIR, ".tasks");
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
