import { exec, type ExecException } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";

import {
    BACKGROUND_STALL_THRESHOLD_MS,
    BACKGROUND_TIMEOUT_MS,
    RUNTIME_TASKS_DIR,
    WORKDIR,
} from "./config";

type BackgroundStatus = "running" | "completed" | "timeout" | "error";

type BackgroundRecord = {
    id: string;
    status: BackgroundStatus;
    result: string | null;
    command: string;
    started_at: number;
    finished_at: number | null;
    result_preview: string;
    output_file: string;
};

type BackgroundNotification = {
    task_id: string;
    status: BackgroundStatus;
    command: string;
    preview: string;
    output_file: string;
};

export class BackgroundManager {
    private readonly tasks = new Map<string, BackgroundRecord>();
    private readonly notificationQueue: BackgroundNotification[] = [];

    constructor(private readonly runtimeDir = RUNTIME_TASKS_DIR) {
        mkdirSync(this.runtimeDir, { recursive: true });
    }

    run(command: string): string {
        const taskId = randomUUID().slice(0, 8);
        const outputFile = this.outputPath(taskId);
        const record: BackgroundRecord = {
            id: taskId,
            status: "running",
            result: null,
            command,
            started_at: Date.now() / 1000,
            finished_at: null,
            result_preview: "",
            output_file: relative(WORKDIR, outputFile),
        };

        this.tasks.set(taskId, record);
        this.persistTask(taskId);
        this.execute(taskId, command);

        return `Background task ${taskId} started: ${command.slice(0, 80)} (output_file=${relative(WORKDIR, outputFile)})`;
    }

    check(taskId?: string): string {
        if (taskId) {
            const task = this.tasks.get(taskId);
            if (!task) {
                return `Error: Unknown task ${taskId}`;
            }
            return JSON.stringify(
                {
                    id: task.id,
                    status: task.status,
                    command: task.command,
                    result_preview: task.result_preview,
                    output_file: task.output_file,
                },
                null,
                2,
            );
        }

        const lines = [...this.tasks.entries()].map(
            ([id, task]) =>
                `${id}: [${task.status}] ${task.command.slice(0, 60)} -> ${task.result_preview || "(running)"}`,
        );
        return lines.length > 0 ? lines.join("\n") : "No background tasks.";
    }

    drainNotifications(): BackgroundNotification[] {
        const notifications = [...this.notificationQueue];
        this.notificationQueue.splice(0, this.notificationQueue.length);
        return notifications;
    }

    detectStalled(): string[] {
        const now = Date.now() / 1000;
        const stalled: string[] = [];
        for (const [taskId, info] of this.tasks.entries()) {
            if (info.status !== "running") {
                continue;
            }
            const elapsedMs = (now - info.started_at) * 1000;
            if (elapsedMs > BACKGROUND_STALL_THRESHOLD_MS) {
                stalled.push(taskId);
            }
        }
        return stalled;
    }

    private execute(taskId: string, command: string): void {
        exec(
            command,
            {
                cwd: WORKDIR,
                encoding: "utf8",
                timeout: BACKGROUND_TIMEOUT_MS,
                maxBuffer: 50_000_000,
            },
            (error, stdout, stderr) => {
                const rawOutput = `${stdout ?? ""}${stderr ?? ""}`.trim();
                let output = rawOutput.slice(0, 50_000);
                let status: BackgroundStatus = "completed";

                if (error) {
                    status = isTimeoutError(error) ? "timeout" : "error";
                    output = output || `Error: ${error.message}`;
                    if (status === "timeout") {
                        output = "Error: Timeout (300s)";
                    }
                }

                const finalOutput = output || "(no output)";
                const preview = this.preview(finalOutput);
                const outputPath = this.outputPath(taskId);
                writeFileSync(outputPath, finalOutput);

                const task = this.tasks.get(taskId);
                if (!task) {
                    return;
                }
                task.status = status;
                task.result = finalOutput;
                task.finished_at = Date.now() / 1000;
                task.result_preview = preview;
                this.persistTask(taskId);
                this.notificationQueue.push({
                    task_id: taskId,
                    status,
                    command: command.slice(0, 80),
                    preview,
                    output_file: relative(WORKDIR, outputPath),
                });
            },
        );
    }

    private persistTask(taskId: string): void {
        const task = this.tasks.get(taskId);
        if (!task) {
            return;
        }
        writeFileSync(this.recordPath(taskId), JSON.stringify(task, null, 2));
    }

    private recordPath(taskId: string): string {
        return resolve(this.runtimeDir, `${taskId}.json`);
    }

    private outputPath(taskId: string): string {
        return resolve(this.runtimeDir, `${taskId}.log`);
    }

    private preview(output: string, limit = 500): string {
        return (output || "(no output)").split(/\s+/).join(" ").slice(0, limit);
    }
}

function isTimeoutError(error: ExecException): boolean {
    return (
        error.message.includes("timed out") ||
        (error.killed === true && error.signal === "SIGTERM")
    );
}
