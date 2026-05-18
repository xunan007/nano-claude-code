import { PLAN_REMINDER_INTERVAL } from "./config";
import type { PlanItem, PlanningState, PlanStatus } from "./types";

export class TodoManager {
    readonly state: PlanningState = {
        items: [],
        roundsSinceUpdate: 0,
    };

    update(items: unknown[]): string {
        if (items.length > 12) {
            throw new Error("Keep the session plan short (max 12 items)");
        }

        const normalized: PlanItem[] = [];
        let inProgressCount = 0;

        for (const [index, rawItem] of items.entries()) {
            if (
                rawItem === null ||
                typeof rawItem !== "object" ||
                Array.isArray(rawItem)
            ) {
                throw new Error(`Item ${index}: item must be an object`);
            }

            const item = rawItem as Record<string, unknown>;
            const content = String(item.content ?? "").trim();
            const status = String(item.status ?? "pending").toLowerCase();
            const activeForm = String(item.activeForm ?? "").trim();

            if (!content) {
                throw new Error(`Item ${index}: content required`);
            }
            if (!this.isPlanStatus(status)) {
                throw new Error(`Item ${index}: invalid status '${status}'`);
            }
            if (status === "in_progress") {
                inProgressCount += 1;
            }

            normalized.push({
                content,
                status,
                activeForm,
            });
        }

        if (inProgressCount > 1) {
            throw new Error("Only one plan item can be in_progress");
        }

        this.state.items = normalized;
        this.state.roundsSinceUpdate = 0;
        return this.render();
    }

    noteToolRoundWithoutTodoUpdate(didUpdateTodo: boolean): string | undefined {
        if (!this.isOpenStatus()) {
            return undefined;
        }
        if (didUpdateTodo) {
            return undefined;
        }
        this.state.roundsSinceUpdate += 1;
        if (this.state.roundsSinceUpdate < PLAN_REMINDER_INTERVAL) {
            return undefined;
        }
        return "<reminder>Refresh your current plan before continuing.</reminder>";
    }

    render(): string {
        if (this.state.items.length === 0) {
            return "No session plan yet.";
        }

        const lines = this.state.items.map((item) => {
            const marker = {
                pending: "[ ]",
                in_progress: "[>]",
                completed: "[x]",
            }[item.status];
            const activeSuffix =
                item.status === "in_progress" && item.activeForm
                    ? ` (${item.activeForm})`
                    : "";
            return `${marker} ${item.content}${activeSuffix}`;
        });
        const completed = this.state.items.filter(
            (item) => item.status === "completed",
        ).length;

        lines.push(`\n(${completed}/${this.state.items.length} completed)`);
        return lines.join("\n");
    }

    private isOpenStatus(): boolean {
        return this.state.items.length > 0;
    }

    private isPlanStatus(status: string): status is PlanStatus {
        return ["pending", "in_progress", "completed"].includes(status);
    }
}
