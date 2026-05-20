export const PERMISSION_MODES = ["default", "plan", "auto", "bypass"] as const;

export type PermissionMode = (typeof PERMISSION_MODES)[number];

export type PermissionBehavior = "allow" | "deny" | "ask";

export type PermissionRule = {
    tool: string;
    path?: string;
    content?: string;
    behavior: PermissionBehavior;
};

export type PermissionDecision = {
    behavior: PermissionBehavior;
    reason: string;
};

type ApprovalAnswer = "yes" | "no" | "always";

type PermissionManagerOptions = {
    mode?: PermissionMode;
    rules?: PermissionRule[];
    askApproval?: (
        toolName: string,
        toolInput: Record<string, unknown>,
    ) => Promise<ApprovalAnswer>;
};

type BashValidationFailure = {
    name: string;
    pattern: RegExp;
};

export const READ_ONLY_TOOLS = new Set([
    "read_file",
    "load_skill",
    "compact",
    "task_list",
    "task_get",
]);
export const WRITE_TOOLS = new Set([
    "bash",
    "write_file",
    "edit_file",
    "task",
    "task_create",
    "task_update",
]);

export const DEFAULT_PERMISSION_RULES: PermissionRule[] = [
    { tool: "bash", content: "rm -rf /", behavior: "deny" },
    { tool: "bash", content: "sudo *", behavior: "deny" },
    { tool: "read_file", path: "*", behavior: "allow" },
    { tool: "load_skill", path: "*", behavior: "allow" },
    { tool: "task_list", path: "*", behavior: "allow" },
    { tool: "task_get", path: "*", behavior: "allow" },
];

export class BashSecurityValidator {
    private readonly validators: [string, RegExp][] = [
        ["shell_metachar", /[;&|`$]/],
        ["sudo", /\bsudo\b/],
        ["rm_rf", /\brm\s+(-[a-zA-Z]*)?r/],
        ["cmd_substitution", /\$\(/],
        ["ifs_injection", /\bIFS\s*=/],
    ];

    validate(command: string): BashValidationFailure[] {
        const failures: BashValidationFailure[] = [];
        for (const [name, pattern] of this.validators) {
            if (pattern.test(command)) {
                failures.push({ name, pattern });
            }
        }
        return failures;
    }

    isSafe(command: string): boolean {
        return this.validate(command).length === 0;
    }

    describeFailures(command: string): string {
        const failures = this.validate(command);
        if (failures.length === 0) {
            return "No issues detected";
        }
        const parts = failures.map(
            (failure) => `${failure.name} (pattern: ${failure.pattern.source})`,
        );
        return `Security flags: ${parts.join(", ")}`;
    }
}

export class PermissionManager {
    private readonly bashValidator = new BashSecurityValidator();
    private readonly askApproval?: PermissionManagerOptions["askApproval"];
    readonly rules: PermissionRule[];
    consecutiveDenials = 0;
    maxConsecutiveDenials = 3;

    constructor(options: PermissionManagerOptions = {}) {
        this.mode = options.mode ?? "default";
        this.rules = options.rules
            ? [...options.rules]
            : [...DEFAULT_PERMISSION_RULES];
        this.askApproval = options.askApproval;
    }

    private permissionMode: PermissionMode = "default";

    get mode(): PermissionMode {
        return this.permissionMode;
    }

    set mode(mode: PermissionMode) {
        if (!isPermissionMode(mode)) {
            throw new Error(
                `Unknown mode: ${mode}. Choose from ${PERMISSION_MODES.join(", ")}`,
            );
        }
        this.permissionMode = mode;
    }

    check(
        toolName: string,
        toolInput: Record<string, unknown>,
    ): PermissionDecision {
        let bashFlagReason: string | undefined;

        // 1. bash 比较特殊，严重风险前置拒绝；非严重风险先记录，
        // 等 mode check 之后再决定是否询问，避免绕过 plan mode。
        if (toolName === "bash") {
            const command = getString(toolInput.command);
            const failures = this.bashValidator.validate(command);
            if (failures.length > 0) {
                const severe = new Set(["sudo", "rm_rf"]);
                const hasSevere = failures.some((failure) =>
                    severe.has(failure.name),
                );
                const description =
                    this.bashValidator.describeFailures(command);
                if (hasSevere) {
                    return {
                        behavior: "deny",
                        reason: `Bash validator: ${description}`,
                    };
                }
                bashFlagReason = `Bash validator flagged: ${description}`;
            }
        }

        // 2. 把明确拒绝的先挡掉
        for (const rule of this.rules) {
            if (rule.behavior !== "deny") {
                continue;
            }
            if (this.matches(rule, toolName, toolInput)) {
                return {
                    behavior: "deny",
                    reason: `Blocked by deny rule: ${JSON.stringify(rule)}`,
                };
            }
        }

        // 3. 根据模式校验

        if (this.mode === "bypass") {
            this.consecutiveDenials = 0;
            return {
                behavior: "allow",
                reason: "Bypass mode: all non-denied tools auto-approved",
            };
        }

        if (this.mode === "plan") {
            if (WRITE_TOOLS.has(toolName)) {
                return {
                    behavior: "deny",
                    reason: "Plan mode: write operations are blocked",
                };
            }
            return {
                behavior: "allow",
                reason: "Plan mode: read-only allowed",
            };
        }

        if (this.mode === "auto" && READ_ONLY_TOOLS.has(toolName)) {
            return {
                behavior: "allow",
                reason: "Auto mode: read-only tool auto-approved",
            };
        }

        if (bashFlagReason) {
            return {
                behavior: "ask",
                reason: bashFlagReason,
            };
        }

        // 4. 允许的通行
        for (const rule of this.rules) {
            if (rule.behavior !== "allow") {
                continue;
            }
            if (this.matches(rule, toolName, toolInput)) {
                this.consecutiveDenials = 0;
                return {
                    behavior: "allow",
                    reason: `Matched allow rule: ${JSON.stringify(rule)}`,
                };
            }
        }

        // 5. 未知的询问
        return {
            behavior: "ask",
            reason: `No rule matched for ${toolName}, asking user`,
        };
    }

    async askUser(
        toolName: string,
        toolInput: Record<string, unknown>,
    ): Promise<boolean> {
        if (!this.askApproval) {
            this.consecutiveDenials += 1;
            return false;
        }

        const answer = await this.askApproval(toolName, toolInput);
        if (answer === "always") {
            this.rules.push({
                tool: toolName,
                path: "*",
                behavior: "allow",
            });
            this.consecutiveDenials = 0;
            return true;
        }
        if (answer === "yes") {
            this.consecutiveDenials = 0;
            return true;
        }

        this.consecutiveDenials += 1;
        return false;
    }

    private matches(
        rule: PermissionRule,
        toolName: string,
        toolInput: Record<string, unknown>,
    ): boolean {
        if (rule.tool && rule.tool !== "*" && rule.tool !== toolName) {
            return false;
        }

        if (rule.path !== undefined && rule.path !== "*") {
            const path = getString(toolInput.path);
            if (!matchesGlob(path, rule.path)) {
                return false;
            }
        }

        if (rule.content !== undefined) {
            const command = getString(toolInput.command);
            if (!matchesGlob(command, rule.content)) {
                return false;
            }
        }

        return true;
    }
}

export function isPermissionMode(value: string): value is PermissionMode {
    return (PERMISSION_MODES as readonly string[]).includes(value);
}

function getString(value: unknown): string {
    return typeof value === "string" ? value : "";
}

function matchesGlob(value: string, pattern: string): boolean {
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(`^${escaped.replace(/\*/g, ".*")}$`);
    return regex.test(value);
}
