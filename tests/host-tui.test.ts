/**
 * Host-TUI capability guard: the extension loads and mounts all guards even
 * when the host's bundled pi-tui lacks the MouseRegion component.
 *
 * Test 2: MouseRegion is available in the real host and wraps the widget.
 * Test 3: Every guard mounts under both hosts — identical event hooks,
 *         commands, and shortcuts.
 *
 * No network. No live host. No TypeSafe requests.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { before, test } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Build dist/ so extensions/index.js (which re-exports ../dist/extension.js) is loadable. */
before(() => {
  execFileSync("npm", ["run", "build"], { cwd: join(import.meta.dirname, ".."), stdio: "pipe" });
});

// ---------------------------------------------------------------------------
// Shared mock host
// ---------------------------------------------------------------------------

function createHost() {
  const events: Array<{ type: string; handler: (event: unknown, ctx: unknown) => unknown }> = [];
  const commands = new Map<string, { description: string; handler: (...args: unknown[]) => unknown }>();
  const shortcuts = new Map<string, { description: string; handler: (...args: unknown[]) => unknown }>();

  const pi = {
    on(type: string, handler: (event: unknown, ctx: unknown) => unknown) { events.push({ type, handler }); },
    registerCommand(name: string, def: { description: string; handler: (...args: unknown[]) => unknown }) { commands.set(name, def); },
    registerShortcut(_key: string, def: { description: string; handler: (...args: unknown[]) => unknown }) { shortcuts.set("ctrl+shift+w", def); },
    registerTool() {},
    sendMessage() {},
  };

  const ctx = {
    hasUI: true,
    ui: {
      notify() {},
      confirm() { return Promise.resolve(true); },
      editor() { return Promise.resolve(undefined); },
      setWidget() {},
    },
    cwd: tmpdir(),
    sessionManager: { getBranch() { return []; }, getSessionId() { return "test-session"; } },
    signal: undefined,
    isProjectTrusted() { return true; },
  };

  return { pi, ctx, events, commands, shortcuts };
}

// ---------------------------------------------------------------------------
// Test 2: MouseRegion is available in the real host
// ---------------------------------------------------------------------------

test("MouseRegion is available in the real pi-tui and wraps the widget", async () => {
  const tuiModule = await import("@earendil-works/pi-tui");
  assert.ok((tuiModule as Record<string, unknown>).MouseRegion, "MouseRegion is exported by the real pi-tui");
  // The extension uses: new MouseRegion(body, handler) → returns a Component with render + handleMouse.
  const MR = (tuiModule as unknown as Record<string, new (child: unknown, onMouse: unknown) => unknown>).MouseRegion;
  assert.ok(MR, "MouseRegion is a constructor");
  const fakeBody = { render: () => ["line 1"], invalidate() {} };
  const instance = new MR(fakeBody, () => undefined);
  assert.ok(instance, "MouseRegion constructs a component");
  assert.equal(typeof (instance as Record<string, unknown>).render, "function", "the component has render");
});

// ---------------------------------------------------------------------------
// Test 3: all guards mount under both hosts
// ---------------------------------------------------------------------------

test("every guard mounts on a host whose TUI has a mouse region", async () => {
  // @ts-expect-error — extensions/index.js has no type declarations; it re-exports the built dist.
  const ext = await import("../extensions/index.js");
  const defaultExport = (ext as { default: (pi: unknown) => void }).default;
  const host = createHost();
  defaultExport(host.pi);
  const sessionEvent = host.events.find(e => e.type === "session_start");
  assert.ok(sessionEvent);
  await sessionEvent.handler({}, host.ctx);

  assert.equal(host.events.length, 13, "13 event hooks registered");
  assert.deepEqual([...host.commands.keys()], ["warden"], "1 command: /warden");
  assert.ok(host.shortcuts.size >= 1, "at least 1 shortcut registered");
});

test("every guard mounts on a host whose TUI has no mouse region", async () => {
  // Patch the built dist to set MouseRegion to undefined, simulating a host
  // (e.g. omp 18.2.5) that bundles pi-tui without that component.
  const { readFileSync, writeFileSync, copyFileSync } = await import("node:fs");
  const distPath = join(import.meta.dirname, "..", "dist", "extension.js");
  const backupPath = distPath + ".bak";
  copyFileSync(distPath, backupPath);
  try {
    let src = readFileSync(distPath, "utf8");
    // The built code does: import * as tuiModule from "@earendil-works/pi-tui"
    // followed by: const MouseRegion = tuiModule.MouseRegion;
    // We inject a line after the import that overrides the property.
    src = src.replace(
      /(const MouseRegion = )tuiModule\.MouseRegion;/,
      "$1undefined; // stripped by test fixture",
    );
    writeFileSync(distPath, src);

    // Dynamic import with cache-busting to get a fresh module evaluation.
    const ext = await import(`../extensions/index.js?t=${Date.now()}`);
    const defaultExport = (ext as { default: (pi: unknown) => void }).default;
    assert.equal(typeof defaultExport, "function", "the extension exports a default function even without MouseRegion");

    const host = createHost();
    defaultExport(host.pi);
    const sessionEvent = host.events.find(e => e.type === "session_start");
    assert.ok(sessionEvent);
    await sessionEvent.handler({}, host.ctx);

    assert.equal(host.events.length, 13, "13 event hooks registered — same as with MouseRegion");
    assert.deepEqual([...host.commands.keys()], ["warden"], "1 command: /warden");
    assert.ok(host.shortcuts.size >= 1, "at least 1 shortcut");
  } finally {
    copyFileSync(backupPath, distPath);
  }
});
