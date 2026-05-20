import {
    existsSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { TASKS_DIR } from "./config";

export type TaskStatus = "pending" | "in_progress" | "completed" | "deleted";

export type TaskRecord = {
    id: number;
    subject: string;
    description: string;
    status: TaskStatus;
    blockedBy: number[];
    blocks: number[];
    owner: string;
};

export class TaskManager {
    private nextId: number;
    private readonly createdThisSession = new Set<number>();

    constructor(private readonly tasksDir = TASKS_DIR) {
        mkdirSync(this.tasksDir, { recursive: true });
        this.nextId = this.maxId() + 1;
    }

    create(subject: string, description = ""): string {
        const task: TaskRecord = {
            id: this.nextId,
            subject,
            description,
            status: "pending",
            blockedBy: [],
            blocks: [],
            owner: "",
        };
        this.save(task);
        this.createdThisSession.add(task.id);
        this.nextId += 1;
        return JSON.stringify(task, null, 2);
    }

    get(taskId: number): string {
        return JSON.stringify(this.load(taskId), null, 2);
    }

    update(
        taskId: number,
        status?: string,
        owner?: string,
        addBlockedBy?: number[],
        addBlocks?: number[],
    ): string {
        const task = this.load(taskId);

        if (owner !== undefined) {
            task.owner = owner;
        }

        if (status) {
            if (!isTaskStatus(status)) {
                throw new Error(`Invalid status: ${status}`);
            }
            task.status = status;
            if (status === "completed") {
                this.clearDependency(taskId);
            }
        }

        if (addBlockedBy && addBlockedBy.length > 0) {
            task.blockedBy = [...new Set([...task.blockedBy, ...addBlockedBy])];
            for (const prerequisiteId of addBlockedBy) {
                try {
                    const prerequisite = this.load(prerequisiteId);
                    if (!prerequisite.blocks.includes(taskId)) {
                        prerequisite.blocks.push(taskId);
                        this.save(prerequisite);
                    }
                } catch (error: unknown) {
                    if (
                        !(error instanceof Error) ||
                        error.message !== `Task ${prerequisiteId} not found`
                    ) {
                        throw error;
                    }
                }
            }
        }

        if (addBlocks && addBlocks.length > 0) {
            task.blocks = [...new Set([...task.blocks, ...addBlocks])];
            for (const blockedId of addBlocks) {
                try {
                    const blocked = this.load(blockedId);
                    if (!blocked.blockedBy.includes(taskId)) {
                        blocked.blockedBy.push(taskId);
                        this.save(blocked);
                    }
                } catch (error: unknown) {
                    if (
                        !(error instanceof Error) ||
                        error.message !== `Task ${blockedId} not found`
                    ) {
                        throw error;
                    }
                }
            }
        }

        this.save(task);
        return JSON.stringify(task, null, 2);
    }

    listAll(): string {
        const tasks = this.currentTaskRecords();

        if (tasks.length === 0) {
            return "No tasks.";
        }

        return tasks
            .map((task) => {
                const marker =
                    {
                        pending: "[ ]",
                        in_progress: "[>]",
                        completed: "[x]",
                        deleted: "[-]",
                    }[task.status] ?? "[?]";
                const blocked =
                    task.blockedBy.length > 0
                        ? ` (blocked by: ${JSON.stringify(task.blockedBy)})`
                        : "";
                const blocks =
                    task.blocks.length > 0
                        ? ` (blocks: ${JSON.stringify(task.blocks)})`
                        : "";
                const owner = task.owner ? ` owner=${task.owner}` : "";
                return `${marker} #${task.id}: ${task.subject}${owner}${blocked}${blocks}`;
            })
            .join("\n");
    }

    private maxId(): number {
        const ids = this.taskFiles().map((fileName) =>
            Number(fileName.slice("task_".length, -".json".length)),
        );
        return ids.length > 0 ? Math.max(...ids) : 0;
    }

    private taskFiles(): string[] {
        return readdirSync(this.tasksDir)
            .filter((fileName) => /^task_\d+\.json$/.test(fileName))
            .sort((a, b) => taskIdFromFile(a) - taskIdFromFile(b));
    }

    private currentTaskRecords(): TaskRecord[] {
        const tasks = this.taskFiles().map((fileName) =>
            JSON.parse(readFileSync(join(this.tasksDir, fileName), "utf8")),
        ) as TaskRecord[];
        if (this.createdThisSession.size === 0) {
            return tasks;
        }
        return tasks.filter((task) => this.createdThisSession.has(task.id));
    }

    private load(taskId: number): TaskRecord {
        const path = join(this.tasksDir, `task_${taskId}.json`);
        if (!existsSync(path)) {
            throw new Error(`Task ${taskId} not found`);
        }
        return JSON.parse(readFileSync(path, "utf8")) as TaskRecord;
    }

    private save(task: TaskRecord): void {
        const path = join(this.tasksDir, `task_${task.id}.json`);
        writeFileSync(path, JSON.stringify(task, null, 2));
    }

    private clearDependency(completedId: number): void {
        for (const fileName of this.taskFiles()) {
            const task = JSON.parse(
                readFileSync(join(this.tasksDir, fileName), "utf8"),
            ) as TaskRecord;
            if (task.blockedBy.includes(completedId)) {
                task.blockedBy = task.blockedBy.filter(
                    (id) => id !== completedId,
                );
                this.save(task);
            }
        }
    }
}

function isTaskStatus(status: string): status is TaskStatus {
    return ["pending", "in_progress", "completed", "deleted"].includes(status);
}

function taskIdFromFile(fileName: string): number {
    return Number(fileName.slice("task_".length, -".json".length));
}
