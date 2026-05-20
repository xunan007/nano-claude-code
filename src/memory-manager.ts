import {
    existsSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    unlinkSync,
    writeFileSync,
} from "node:fs";
import { basename, join, relative } from "node:path";
import { pid } from "node:process";

import { MEMORY_DIR, WORKDIR } from "./config";

export const MEMORY_TYPES = [
    "user",
    "feedback",
    "project",
    "reference",
] as const;

export type MemoryType = (typeof MEMORY_TYPES)[number];

type MemoryEntry = {
    description: string;
    type: MemoryType;
    content: string;
    file: string;
};

const MAX_INDEX_LINES = 200;

export class MemoryManager {
    private readonly memories = new Map<string, MemoryEntry>();

    constructor(private readonly memoryDir = MEMORY_DIR) {}

    loadAll(): void {
        this.memories.clear();
        if (!existsSync(this.memoryDir)) {
            return;
        }

        for (const fileName of readdirSync(this.memoryDir).sort()) {
            if (!fileName.endsWith(".md") || fileName === "MEMORY.md") {
                continue;
            }

            const path = join(this.memoryDir, fileName);
            const parsed = this.parseFrontmatter(readFileSync(path, "utf8"));
            if (!parsed) {
                continue;
            }

            const name = parsed.metadata.name || basename(fileName, ".md");
            this.memories.set(name, {
                description: parsed.metadata.description || "",
                type: toMemoryType(parsed.metadata.type),
                content: parsed.body.trim(),
                file: fileName,
            });
        }

        if (this.memories.size > 0) {
            console.log(
                `[Memory loaded: ${this.memories.size} memories from ${relative(
                    WORKDIR,
                    this.memoryDir,
                )}]`,
            );
        }
    }

    count(): number {
        return this.memories.size;
    }

    list(): string[] {
        return [...this.memories.entries()].map(
            ([name, memory]) =>
                `  [${memory.type}] ${name}: ${memory.description}`,
        );
    }

    loadMemoryPrompt(): string {
        if (this.memories.size === 0) {
            return "";
        }

        const sections = ["# Memories (persistent across sessions)", ""];
        for (const type of MEMORY_TYPES) {
            const typed = [...this.memories.entries()].filter(
                ([, memory]) => memory.type === type,
            );
            if (typed.length === 0) {
                continue;
            }

            sections.push(`## [${type}]`);
            for (const [name, memory] of typed) {
                sections.push(`### ${name}: ${memory.description}`);
                if (memory.content.trim()) {
                    sections.push(memory.content.trim());
                }
                sections.push("");
            }
        }

        return sections.join("\n");
    }

    saveMemory(
        name: string,
        description: string,
        type: string,
        content: string,
    ): string {
        if (!isMemoryType(type)) {
            return `Error: type must be one of ${MEMORY_TYPES.join(", ")}`;
        }

        const safeName = name.toLowerCase().replace(/[^a-z0-9_-]/gi, "_");
        if (!safeName) {
            return "Error: invalid memory name";
        }

        mkdirSync(this.memoryDir, { recursive: true });
        const fileName = `${safeName}.md`;
        const path = join(this.memoryDir, fileName);
        const frontmatter = [
            "---",
            `name: ${name}`,
            `description: ${description}`,
            `type: ${type}`,
            "---",
            content,
            "",
        ].join("\n");

        writeFileSync(path, frontmatter);
        this.memories.set(name, {
            description,
            type,
            content,
            file: fileName,
        });
        this.rebuildIndex();

        return `Saved memory '${name}' [${type}] to ${relative(WORKDIR, path)}`;
    }

    private rebuildIndex(): void {
        const lines = ["# Memory Index", ""];
        for (const [name, memory] of this.memories.entries()) {
            lines.push(`- ${name}: ${memory.description} [${memory.type}]`);
            if (lines.length >= MAX_INDEX_LINES) {
                lines.push(`... (truncated at ${MAX_INDEX_LINES} lines)`);
                break;
            }
        }

        mkdirSync(this.memoryDir, { recursive: true });
        writeFileSync(
            join(this.memoryDir, "MEMORY.md"),
            `${lines.join("\n")}\n`,
        );
    }

    private parseFrontmatter(text: string):
        | {
              metadata: Record<string, string>;
              body: string;
          }
        | undefined {
        const match = /^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)/.exec(text);
        if (!match) {
            return undefined;
        }

        const metadata: Record<string, string> = {};
        for (const line of (match[1] ?? "").split(/\r?\n/)) {
            const separatorIndex = line.indexOf(":");
            if (separatorIndex === -1) {
                continue;
            }
            const key = line.slice(0, separatorIndex).trim();
            const value = line.slice(separatorIndex + 1).trim();
            if (key) {
                metadata[key] = value;
            }
        }

        return {
            metadata,
            body: match[2] ?? "",
        };
    }
}

export class DreamConsolidator {
    private static readonly COOLDOWN_MS = 86_400_000;
    private static readonly SCAN_THROTTLE_MS = 600_000;
    private static readonly MIN_SESSION_COUNT = 5;
    private static readonly LOCK_STALE_MS = 3_600_000;
    private static readonly PHASES = [
        "Orient: scan MEMORY.md index for structure and categories",
        "Gather: read individual memory files for full content",
        "Consolidate: merge related memories, remove stale entries",
        "Prune: enforce 200-line limit on MEMORY.md index",
    ];

    enabled = true;
    mode: "default" | "plan" = "default";
    lastConsolidationTime = 0;
    lastScanTime = 0;
    sessionCount = 0;

    private readonly lockFile: string;

    constructor(private readonly memoryDir = MEMORY_DIR) {
        this.lockFile = join(memoryDir, ".dream_lock");
    }

    shouldConsolidate(): [boolean, string] {
        const now = Date.now();
        if (!this.enabled) {
            return [false, "Gate 1: consolidation is disabled"];
        }
        if (!existsSync(this.memoryDir)) {
            return [false, "Gate 2: memory directory does not exist"];
        }

        const memoryFiles = readdirSync(this.memoryDir).filter(
            (fileName) => fileName.endsWith(".md") && fileName !== "MEMORY.md",
        );
        if (memoryFiles.length === 0) {
            return [false, "Gate 2: no memory files found"];
        }
        if (this.mode === "plan") {
            return [false, "Gate 3: plan mode does not allow consolidation"];
        }

        const timeSinceLast = now - this.lastConsolidationTime;
        if (timeSinceLast < DreamConsolidator.COOLDOWN_MS) {
            const remaining = Math.ceil(
                (DreamConsolidator.COOLDOWN_MS - timeSinceLast) / 1000,
            );
            return [false, `Gate 4: cooldown active, ${remaining}s remaining`];
        }

        const timeSinceScan = now - this.lastScanTime;
        if (timeSinceScan < DreamConsolidator.SCAN_THROTTLE_MS) {
            const remaining = Math.ceil(
                (DreamConsolidator.SCAN_THROTTLE_MS - timeSinceScan) / 1000,
            );
            return [
                false,
                `Gate 5: scan throttle active, ${remaining}s remaining`,
            ];
        }

        if (this.sessionCount < DreamConsolidator.MIN_SESSION_COUNT) {
            return [
                false,
                `Gate 6: only ${this.sessionCount} sessions, need ${DreamConsolidator.MIN_SESSION_COUNT}`,
            ];
        }

        if (!this.acquireLock()) {
            return [false, "Gate 7: lock held by another process"];
        }

        return [true, "All 7 gates passed"];
    }

    consolidate(): string[] {
        const [canRun, reason] = this.shouldConsolidate();
        this.lastScanTime = Date.now();
        if (!canRun) {
            console.log(`[Dream] Cannot consolidate: ${reason}`);
            return [];
        }

        console.log("[Dream] Starting consolidation...");
        const completedPhases: string[] = [];
        for (const [index, phase] of DreamConsolidator.PHASES.entries()) {
            console.log(
                `[Dream] Phase ${index + 1}/${DreamConsolidator.PHASES.length}: ${phase}`,
            );
            completedPhases.push(phase);
        }

        this.lastConsolidationTime = Date.now();
        this.releaseLock();
        console.log(
            `[Dream] Consolidation complete: ${completedPhases.length} phases executed`,
        );
        return completedPhases;
    }

    private acquireLock(): boolean {
        if (existsSync(this.lockFile)) {
            try {
                const [pidText, timestampText] = readFileSync(
                    this.lockFile,
                    "utf8",
                )
                    .trim()
                    .split(":", 2);
                const lockPid = Number(pidText);
                const lockTime = Number(timestampText);
                if (Date.now() - lockTime > DreamConsolidator.LOCK_STALE_MS) {
                    console.log(
                        `[Dream] Removing stale lock from PID ${lockPid}`,
                    );
                    unlinkSync(this.lockFile);
                } else {
                    try {
                        process.kill(lockPid, 0);
                        return false;
                    } catch {
                        console.log(
                            `[Dream] Removing lock from dead PID ${lockPid}`,
                        );
                        unlinkSync(this.lockFile);
                    }
                }
            } catch {
                unlinkSync(this.lockFile);
            }
        }

        try {
            mkdirSync(this.memoryDir, { recursive: true });
            writeFileSync(this.lockFile, `${pid}:${Date.now()}`);
            return true;
        } catch {
            return false;
        }
    }

    private releaseLock(): void {
        try {
            if (!existsSync(this.lockFile)) {
                return;
            }
            const [pidText] = readFileSync(this.lockFile, "utf8")
                .trim()
                .split(":", 1);
            if (Number(pidText) === pid) {
                unlinkSync(this.lockFile);
            }
        } catch {
            // Best effort cleanup only.
        }
    }
}

function isMemoryType(type: string): type is MemoryType {
    return MEMORY_TYPES.includes(type as MemoryType);
}

function toMemoryType(type: string | undefined): MemoryType {
    return isMemoryType(type ?? "") ? (type as MemoryType) : "project";
}
