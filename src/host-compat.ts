// src/host-compat.ts - Maps a Pi-compatible host's extension API onto the Pi contract.
//
// pi-warden is written against the Pi extension API. Some hosts load Pi extensions through a
// compatibility layer whose contract differs in a few places. This module is the only place
// that knows about those differences, so the rest of pi-warden stays Pi-only.
//
// On upstream Pi, adaptHost() returns the API unchanged.
//
// The adapted host is one that exposes its session package as `pi.pi` with getActiveSkills()
// (oh-my-pi). Its differences, and what the adapter does:
//  - before_agent_start has no systemPromptOptions: the adapter adds one with the active skills,
//    and turns an appendSystemPrompt set by a handler into the host's systemPrompt array result.
//  - command contexts have no getSystemPromptOptions(): the adapter adds it.
//  - the input result is read as { handled }, not { action: "handled" }: the adapter adds `handled`.
//  - there is no agent_settled event: its handlers run after an agent_end that leaves the host idle.
//  - message_end results are ignored, and a finalized message cannot be replaced another way:
//    context.dedupeMessages has no effect on this host.
import type { ExtensionAPI, Skill } from "@earendil-works/pi-coding-agent";

interface HostSkill {
  name: string;
  description: string;
  filePath: string;
  baseDir?: string;
  /** Loaded but left out of the system prompt listing: Pi's disableModelInvocation. */
  hide?: boolean;
}

type PiSkill = Pick<Skill, "name" | "description" | "filePath" | "baseDir" | "disableModelInvocation">;
type SystemPromptOptions = { skills: PiSkill[]; appendSystemPrompt?: string };
// The wrapped handlers are generic over every event, so payloads stay unknown here.
type Handler = (event: unknown, ctx: unknown) => unknown;
type SystemPrompt = string | string[];

export function adaptHost(pi: ExtensionAPI): ExtensionAPI {
  const session = (pi as unknown as { pi?: { getActiveSkills?: () => readonly HostSkill[] } }).pi;
  const getActiveSkills = session?.getActiveSkills;
  if (typeof getActiveSkills !== "function") return pi;
  const systemPromptOptions = (): SystemPromptOptions => ({ skills: getActiveSkills.call(session).map(toPiSkill) });

  const register = pi.on.bind(pi) as (event: string, handler: Handler) => void;
  const on = (event: string, handler: Handler): void => {
    if (event === "before_agent_start") return register(event, (e, ctx) => beforeAgentStart(e, ctx, handler, systemPromptOptions()));
    if (event === "input") return register(event, async (e, ctx) => inputResult(await handler(e, ctx)));
    // Pi emits agent_settled once per prompt, after every agent_end handler and every continuation.
    // The handler is deferred past the agent_end handlers; a host that is still busy then is
    // starting a continuation (a queued follow-up), so the settle waits for the run that ends idle.
    if (event === "agent_settled") {
      return register("agent_end", (_e, ctx) => {
        setImmediate(() => {
          if (!isIdle(ctx)) return;
          Promise.resolve()
            .then(() => handler({ type: "agent_settled" }, ctx))
            .catch(error => console.error("pi-warden: agent_settled handler failed:", error));
        });
      });
    }
    return register(event, handler);
  };

  const registerCommand: ExtensionAPI["registerCommand"] = (name, options) =>
    pi.registerCommand(name, { ...options, handler: (args, ctx) => options.handler(args, withSystemPromptOptions(ctx, systemPromptOptions)) });

  return new Proxy(pi, {
    get(target, property) {
      if (property === "on") return on;
      if (property === "registerCommand") return registerCommand;
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function toPiSkill(skill: HostSkill): PiSkill {
  return {
    name: skill.name,
    description: skill.description,
    filePath: skill.filePath,
    baseDir: skill.baseDir ?? "",
    disableModelInvocation: skill.hide === true,
  };
}

async function beforeAgentStart(event: unknown, ctx: unknown, handler: Handler, options: SystemPromptOptions): Promise<unknown> {
  const result = await handler({ ...(event as object), systemPromptOptions: options }, ctx);
  if (!options.appendSystemPrompt) return result;
  const prompt = systemPromptOf(result) ?? systemPromptOf(event) ?? [];
  return { ...(result as object | undefined), systemPrompt: [...(Array.isArray(prompt) ? prompt : [prompt]), options.appendSystemPrompt] };
}

function systemPromptOf(value: unknown): SystemPrompt | undefined {
  if (!value || typeof value !== "object" || !("systemPrompt" in value)) return undefined;
  const prompt = value.systemPrompt;
  return typeof prompt === "string" || Array.isArray(prompt) ? prompt as SystemPrompt : undefined;
}

function inputResult(result: unknown): unknown {
  const action = (result as { action?: unknown } | undefined)?.action;
  return action === "handled" ? { ...(result as object), handled: true } : result;
}

/** A context without isIdle() cannot report a continuation, so it counts as idle. */
function isIdle(ctx: unknown): boolean {
  const check = (ctx as { isIdle?: unknown } | null)?.isIdle;
  return typeof check === "function" ? check.call(ctx) !== false : true;
}

function withSystemPromptOptions<T extends object>(ctx: T, options: () => SystemPromptOptions): T {
  if (typeof (ctx as { getSystemPromptOptions?: unknown }).getSystemPromptOptions === "function") return ctx;
  return new Proxy(ctx, {
    get(target, property) {
      if (property === "getSystemPromptOptions") return options;
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
