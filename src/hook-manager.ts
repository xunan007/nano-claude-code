export const HOOK_EVENTS = [
    "SessionStart",
    "PreToolUse",
    "PostToolUse",
] as const;

export type HookEvent = (typeof HOOK_EVENTS)[number];

export type SessionStartContext = {
    source: "startup";
};

export type PreToolUseContext = {
    toolName: string;
    toolInput: Record<string, unknown>;
    toolUseId: string;
};

export type PostToolUseContext = PreToolUseContext & {
    toolOutput: string;
};

export type HookContextByEvent = {
    SessionStart: SessionStartContext;
    PreToolUse: PreToolUseContext;
    PostToolUse: PostToolUseContext;
};

type HookContext = HookContextByEvent[HookEvent];

export type HookResult = {
    blocked?: boolean;
    blockReason?: string;
    messages?: string[];
    updatedInput?: Record<string, unknown>;
};

export type HookHandler<Event extends HookEvent = HookEvent> = (
    context: HookContextByEvent[Event],
) => HookResult | void | Promise<HookResult | void>;

type HookEntry<Event extends HookEvent = HookEvent> = {
    name: string;
    event: Event;
    handler: HookHandler<Event>;
};

export class HookManager {
    private readonly hooks: {
        [Event in HookEvent]: HookEntry<Event>[];
    } = {
        SessionStart: [],
        PreToolUse: [],
        PostToolUse: [],
    };

    registerHook<Event extends HookEvent>(
        event: Event,
        name: string,
        handler: HookHandler<Event>,
    ): void {
        this.hooks[event].push({ event, name, handler });
    }

    async runHooks<Event extends HookEvent>(
        event: Event,
        context: HookContextByEvent[Event],
    ): Promise<HookResult> {
        const aggregate: HookResult = { messages: [] };

        for (const hook of this.hooks[event]) {
            const result = await hook.handler(context);
            if (!result) {
                continue;
            }
            if (result.updatedInput && hasToolInput(context)) {
                context.toolInput = result.updatedInput;
                aggregate.updatedInput = result.updatedInput;
            }
            if (result.messages) {
                aggregate.messages?.push(...result.messages);
            }
            if (result.blocked) {
                aggregate.blocked = true;
                aggregate.blockReason =
                    result.blockReason ?? `Blocked by hook: ${hook.name}`;
                break;
            }
        }

        return aggregate;
    }
}

function hasToolInput(
    context: HookContext,
): context is PreToolUseContext | PostToolUseContext {
    return "toolInput" in context;
}
