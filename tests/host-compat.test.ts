import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { adaptHost } from "../src/host-compat.js";

type Handler = (event: unknown, ctx: unknown) => unknown;

/** A host API with the given extras; `on` and `registerCommand` record what the extension registers. */
function fakeHost(extras: Record<string, unknown> = {}) {
  const handlers = new Map<string, Handler[]>();
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => unknown }>();
  const api = {
    ...extras,
    on(event: string, handler: Handler) { handlers.set(event, [...(handlers.get(event) ?? []), handler]); },
    registerCommand(name: string, options: { handler: (args: string, ctx: unknown) => unknown }) { commands.set(name, options); },
  };
  const emit = async (event: string, payload: unknown, ctx: unknown = {}) => {
    let result: unknown;
    for (const handler of handlers.get(event) ?? []) result = await handler(payload, ctx);
    return result;
  };
  return { api: api as unknown as ExtensionAPI, handlers, commands, emit };
}

const skillHost = () => fakeHost({
  pi: {
    getActiveSkills: () => [
      { name: "listed", description: "in the prompt", filePath: "/s/listed/SKILL.md", baseDir: "/s/listed", hide: false },
      { name: "hidden", description: "not in the prompt", filePath: "/s/hidden/SKILL.md", baseDir: "/s/hidden", hide: true },
    ],
  },
});

test("adaptHost: a host without a session skill catalog (upstream Pi) gets the API back unchanged", () => {
  const { api } = fakeHost();
  assert.equal(adaptHost(api), api);
});

test("adaptHost: before_agent_start sees the active skills, with hidden skills marked disableModelInvocation", async () => {
  const host = skillHost();
  let seen: { skills: Array<{ name: string; disableModelInvocation: boolean }> } | undefined;
  adaptHost(host.api).on("before_agent_start", (event: { systemPromptOptions?: typeof seen }) => { seen = event.systemPromptOptions; });
  await host.emit("before_agent_start", { type: "before_agent_start", prompt: "hi", systemPrompt: ["base"] });
  assert.deepEqual(seen?.skills.map(skill => [skill.name, skill.disableModelInvocation]), [["listed", false], ["hidden", true]]);
});

test("adaptHost: appendSystemPrompt set by the handler becomes the host's systemPrompt array result", async () => {
  const host = skillHost();
  adaptHost(host.api).on("before_agent_start", (event: { systemPromptOptions?: { appendSystemPrompt?: string } }) => {
    event.systemPromptOptions!.appendSystemPrompt = "tip";
  });
  const result = await host.emit("before_agent_start", { type: "before_agent_start", prompt: "hi", systemPrompt: ["base", "rules"] });
  assert.deepEqual(result, { systemPrompt: ["base", "rules", "tip"] }, "the host prompt is kept and the tip appended");

  const quiet = skillHost();
  adaptHost(quiet.api).on("before_agent_start", () => undefined);
  assert.equal(await quiet.emit("before_agent_start", { type: "before_agent_start", prompt: "hi", systemPrompt: ["base"] }), undefined, "no tip leaves the prompt alone");
});

test("adaptHost: an input handled by the extension is also marked handled for the host", async () => {
  const host = skillHost();
  const adapted = adaptHost(host.api);
  adapted.on("input", (event: { text: string }) => (event.text === "busy" ? { action: "handled" as const } : { action: "continue" as const }));
  assert.deepEqual(await host.emit("input", { text: "busy" }), { action: "handled", handled: true });
  assert.deepEqual(await host.emit("input", { text: "go" }), { action: "continue" }, "continue is not marked handled");
});

test("adaptHost: agent_settled handlers run after every agent_end handler has finished", async () => {
  const host = skillHost();
  const adapted = adaptHost(host.api);
  const order: string[] = [];
  adapted.on("agent_settled", () => { order.push("settled"); });
  adapted.on("agent_end", async () => { await Promise.resolve(); order.push("end"); });
  assert.equal(host.handlers.has("agent_settled"), false, "the host never emits agent_settled, so nothing waits on it");
  await host.emit("agent_end", { type: "agent_end" }, { isIdle: () => true });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(order, ["end", "settled"]);
});

test("adaptHost: an agent_end followed by a continuation does not settle; the run that ends idle does", async () => {
  const host = skillHost();
  let settled = 0;
  adaptHost(host.api).on("agent_settled", () => { settled++; });
  await host.emit("agent_end", { type: "agent_end" }, { isIdle: () => false });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, 0, "a queued follow-up keeps the host busy, so the prompt is not settled yet");
  await host.emit("agent_end", { type: "agent_end" }, { isIdle: () => true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, 1);
});

test("adaptHost: command contexts get getSystemPromptOptions with the active skills", async () => {
  const host = skillHost();
  let names: string[] = [];
  adaptHost(host.api).registerCommand("warden", {
    description: "test",
    handler: async (_args, ctx) => {
      names = ctx.getSystemPromptOptions().skills?.map(skill => skill.name) ?? [];
    },
  });
  const ctx = { cwd: "/project", isIdle: () => true };
  await host.commands.get("warden")!.handler("index", ctx);
  assert.deepEqual(names, ["listed", "hidden"]);
});
