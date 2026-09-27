import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
// Stub the Pi peer: the specifier resolves to this module through the hook below.
const { register } = await import("node:module");
import { tmpdir } from "node:os";
const hookDir = mkdtempSync(join(tmpdir(), "pi-warden-hooks-"));
const stubPath = join(hookDir, "stub.mjs");
const hooksPath = join(hookDir, "hooks.mjs");
writeFileSync(stubPath, [
  "export function getAgentDir() { return process.env.OMP_DIR; }",
  "export function parseFrontmatter(text) { return {}; }",
  'export const CONFIG_DIR_NAME = ".omp";',
  // pi-tui names the extension imports at runtime; session_start never renders them.
  "export const CURSOR_MARKER = '\\u001b[2K';",
  "export const Key = {};",
  "export function matchesKey() { return false; }",
  "export function truncateToWidth(text) { return text; }",
  "export function wrapTextWithAnsi(text) { return [text]; }",
  "export function Container() { return {}; }",
  "export function Input() { return {}; }",
  "export function Text() { return {}; }",
  "export function Spacer() { return {}; }",
  "export function VStack() { return {}; }",
  "export function HStack() { return {}; }",
  "export function compositeTuiLine() { return []; }",
  "export function isFocusable() { return false; }",
  "export function isViewportTUI() { return false; }",
  "export default {};",
].join("\n"));
writeFileSync(hooksPath, [
  "export async function resolve(specifier, context, next) {",
  "  const peers = ['@earendil-works/pi-coding-agent', '@earendil-works/pi-tui', ];",
  "  if (peers.includes(specifier)) return { url: new URL('file://' + process.env.STUB_PATH).href, shortCircuit: true };",
  "  return next(specifier, context);",
  "}",
].join("\n"));
process.env.STUB_PATH = stubPath;
register(new URL("file://" + hooksPath));
const { default: wardenExtension } = await import(process.env.EXT_PATH!);

const ompDir = process.env.OMP_DIR;
const piDir = process.env.HOME + "/.pi/agent";
const target = join(ompDir, "pi-warden");

// Legacy data present under the Pi default; no marker under omp yet.
mkdirSync(join(piDir, "pi-warden"), { recursive: true });
writeFileSync(join(piDir, "pi-warden", "config.json"), "{}");
mkdirSync(target, { recursive: true });

const notices = [];
const makeHost = () => {
  const handlers = new Map();
  const host = {
    on: (event, handler) => handlers.set(event, handler),
    registerTool: () => {},
    registerCommand: () => {},
    registerShortcut: () => {},
  };
  return { handlers, host };
};

// Interactive first session: notice fires.
const first = makeHost();
wardenExtension(first.host);
const sessionStart = first.handlers.get("session_start");
const ctx = {
  hasUI: true,
  cwd: process.env.WORK_DIR ?? process.env.HOME + "/work",
  sessionManager: { getSessionId: () => "s1" },
  isProjectTrusted: () => true,
  ui: {
    notify: (text, level) => notices.push({ text, level }),
    setWidget: () => {},
    confirm: async () => true,
  },
};
await sessionStart({}, ctx);
assert.equal(notices.length, 1, "first interactive session shows the notice");
// The extension's dirs land in the omp target, not the Pi default: the DB the session itself
// opened (initSchema) is under ompDir, and piDir gained no holds.db of its own.
assert.ok(existsSync(join(target, "holds.db")), "initSchema wrote the database under the omp target");
assert.ok(!existsSync(join(piDir, "pi-warden", "holds.db")), "the Pi default gained no database");
assert.ok(notices[0].text.includes(`{ [ ! -e ${target} ] || mv ${target} ${target}.before-migration; } && cp -R ${join(process.env.HOME + "/.pi/agent", "pi-warden")} ${target}`), "exact conditional mv + cp command");
assert.ok(notices[0].text.includes(process.env.HOME + "/.pi/agent/pi-warden"), "names the legacy folder");
assert.ok(existsSync(join(ompDir, ".pi-warden-migration-notice-shown")), "marker written under the omp target");

// Second interactive session: silent.
const second = makeHost();
wardenExtension(second.host);
await second.handlers.get("session_start")({}, ctx);
assert.equal(notices.length, 1, "second session is silent");

// Headless session with no marker anywhere (fresh target dir): no notice, no marker.
const third = makeHost();
wardenExtension(third.host);
rmSync(join(ompDir, ".pi-warden-migration-notice-shown"));
notices.length = 0;
await third.handlers.get("session_start")({}, { ...ctx, hasUI: false, ui: undefined });
assert.equal(notices.length, 0, "headless session shows nothing");
assert.ok(!existsSync(join(ompDir, ".pi-warden-migration-notice-shown")), "headless session writes no marker");
rmSync(hookDir, { recursive: true, force: true });
console.log("EXT_OMP_NOTICE_OK");
