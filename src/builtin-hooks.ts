import type { HookManager } from "./hook-manager";
import type { PermissionManager } from "./permission-manager";

export function registerPermissionHooks(
    hooks: HookManager,
    permissionManager: PermissionManager,
): void {
    hooks.registerHook("PreToolUse", "permission", async (context) => {
        const decision = permissionManager.check(
            context.toolName,
            context.toolInput,
        );

        if (decision.behavior === "deny") {
            console.log(`  [DENIED] ${context.toolName}: ${decision.reason}`);
            return {
                blocked: true,
                blockReason: `Permission denied: ${decision.reason}`,
            };
        }

        if (decision.behavior !== "ask") {
            return;
        }

        const approved = await permissionManager.askUser(
            context.toolName,
            context.toolInput,
        );
        if (approved) {
            return;
        }

        console.log(`  [USER DENIED] ${context.toolName}`);
        if (
            permissionManager.consecutiveDenials >=
            permissionManager.maxConsecutiveDenials
        ) {
            console.log(
                `  [${permissionManager.consecutiveDenials} consecutive denials -- consider switching to plan mode]`,
            );
        }

        return {
            blocked: true,
            blockReason: `Permission denied by user for ${context.toolName}`,
        };
    });
}
