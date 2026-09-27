/**
 * The library entry must import without the optional Pi peer installed. A child process loads
 * src/index.ts through a resolve hook that makes `@earendil-works/pi-coding-agent` unresolvable
 * (the peer is type-only in library modules) and calls `defaultConfig()` plus the path functions.
 * Type-only imports are erased by tsx, so only a real runtime import would fail here.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");

const child = `
import { register } from "node:module";
register(new URL("data:text/javascript,export%20async%20function%20resolve(specifier%2C%20context%2C%20next)%20%7B%0A%20%20if%20(specifier%20%3D%3D%3D%20%22%40earendil-works%2Fpi-coding-agent%22%20%7C%7C%20specifier.startsWith(%22%40earendil-works%2Fpi-coding-agent%2F%22)%20%7C%7C%20specifier%20%3D%3D%3D%20%22%40earendil-works%2Fpi-tui%22%20%7C%7C%20specifier.startsWith(%22%40earendil-works%2Fpi-tui%2F%22))%20%7B%0A%20%20%20%20throw%20new%20Error(%22blocked%20optional%20peer%20(%22%20%2B%20specifier%20%2B%20%22)%22)%3B%0A%20%20%7D%0A%20%20return%20next(specifier%2C%20context)%3B%0A%7D"));
process.env.PI_CODING_AGENT_DIR = process.env.PI_WARDEN_TEST_AGENT_DIR;
const index = await import("./src/index.ts");
const config = index.defaultConfig();
assert.equal(config.enabled, true);
const dirs = index.defaultHostDirs();
assert.match(dirs.agentDir, /pi-warden-nopi-/);
assert.match(index.userConfigPath(dirs), /config\\.json$/);
await index.initSchema(0, dirs);
console.log("NO_PI_IMPORT_OK");
`;

test("src/index.ts imports and works with the Pi peer unresolvable", async () => {
  const temp = mkdtempSync(join(tmpdir(), "pi-warden-nopi-"));
  try {
    const { stdout } = await run(process.execPath, ["--import", "tsx", "--input-type=module", "-e", child], {
      cwd: root,
      env: { ...process.env, PI_CODING_AGENT_DIR: undefined as unknown as string, PI_WARDEN_DB: join(temp, "holds.db"), PI_WARDEN_TEST_AGENT_DIR: temp },
      encoding: "utf8",
    });
    assert.match(stdout, /NO_PI_IMPORT_OK/);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
