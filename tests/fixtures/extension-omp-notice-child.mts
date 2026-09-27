import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { register } from "node:module";
// The hook lives under OMP_DIR (a temp dir the parent test removes), so a failed run
// leaves no orphan in the shared tmpdir.
const hookDir = mkdtempSync(join(dirname(process.env.OMP_DIR!), "pi-warden-hooks-"));
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
writeFileSync(hooksPath, `import { pathToFileURL } from 'node:url';
export async function resolve(specifier, context, next) {
  const peers = ['@earendil-works/pi-coding-agent', '@earendil-works/pi-tui'];
  if (peers.includes(specifier)) return { url: pathToFileURL(process.env.STUB_PATH).href, shortCircuit: true };
  return next(specifier, context);
}
`);
process.env.STUB_PATH = stubPath;
register(pathToFileURL(hooksPath));
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
  cwd: process.env.WORK_DIR,
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
const q = (value: string) => `'` + value.replaceAll("'", `'\\''`) + `'`;
// The notice names the directories in symlink-free form (macOS temp dirs resolve to /private/var).
const shownTarget = join(realpathSync(ompDir), "pi-warden");
const shownLegacy = join(realpathSync(piDir), "pi-warden");
assert.ok(notices[0].text.includes(`{ [ ! -e ${q(shownTarget)} ] || mv ${q(shownTarget)} ${q(`${shownTarget}.before-migration`)}; } && cp -R ${q(shownLegacy)} ${q(shownTarget)}`), "exact conditional mv + cp command with quoted paths");
assert.ok(notices[0].text.includes(shownLegacy), "names the legacy folder");
assert.ok(existsSync(join(ompDir, ".pi-warden-migration-notice-shown")), "marker written under the omp target");

// Second interactive session: silent.
const second = makeHost();
wardenExtension(second.host);
await second.handlers.get("session_start")({}, ctx);
assert.equal(notices.length, 1, "second session is silent");

// Headless session after the marker is removed: no notice, no marker.
const third = makeHost();
wardenExtension(third.host);
rmSync(join(ompDir, ".pi-warden-migration-notice-shown"));
notices.length = 0;
await third.handlers.get("session_start")({}, { ...ctx, hasUI: false, ui: undefined });
assert.equal(notices.length, 0, "headless session shows nothing");
assert.ok(!existsSync(join(ompDir, ".pi-warden-migration-notice-shown")), "headless session writes no marker");
rmSync(hookDir, { recursive: true, force: true });
console.log("EXT_OMP_NOTICE_OK");
