import { registerPermissionHooks } from "./builtin-hooks";
import type { HookManager } from "./hook-manager";
import {
    isPermissionMode,
    PermissionManager,
    PERMISSION_MODES,
    type PermissionMode,
} from "./permission-manager";

type PermissionPrompt = {
    question(prompt: string): Promise<string>;
};

export async function installPermissionSystem(
    prompt: PermissionPrompt,
    hookManager: HookManager,
): Promise<PermissionManager> {
    const mode = await choosePermissionMode(prompt);
    const permissionManager = createPermissionManager(mode, prompt);
    registerPermissionHooks(hookManager, permissionManager);
    console.log(`[Permission mode: ${mode}]`);
    return permissionManager;
}

export function handlePermissionCommand(
    query: string,
    permissionManager: PermissionManager,
): boolean {
    if (query.startsWith("/mode")) {
        const [, mode] = query.split(/\s+/);
        if (mode && isPermissionMode(mode)) {
            permissionManager.mode = mode;
            console.log(`[Switched to ${mode} mode]`);
        } else {
            console.log(`Usage: /mode <${PERMISSION_MODES.join("|")}>`);
        }
        return true;
    }

    if (query.trim() === "/rules") {
        permissionManager.rules.forEach((rule, index) => {
            console.log(`  ${index}: ${JSON.stringify(rule)}`);
        });
        return true;
    }

    return false;
}

async function choosePermissionMode(
    prompt: PermissionPrompt,
): Promise<PermissionMode> {
    console.log(`Permission modes: ${PERMISSION_MODES.join(", ")}`);
    const modeInput = (await prompt.question("Mode (default): "))
        .trim()
        .toLowerCase();
    if (!modeInput) {
        return "default";
    }
    return isPermissionMode(modeInput) ? modeInput : "default";
}

function createPermissionManager(
    mode: PermissionMode,
    prompt: PermissionPrompt,
): PermissionManager {
    return new PermissionManager({
        mode,
        askApproval: async (toolName, toolInput) => {
            const preview = JSON.stringify(toolInput).slice(0, 200);
            console.log(`\n  [Permission] ${toolName}: ${preview}`);
            const answer = (await prompt.question("  Allow? (y/n/always): "))
                .trim()
                .toLowerCase();
            if (answer === "always") {
                return "always";
            }
            if (answer === "y" || answer === "yes") {
                return "yes";
            }
            return "no";
        },
    });
}
