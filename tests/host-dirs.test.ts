/**
 * Host directory injection: `defaultHostDirs` cases, and every library path function placing its
 * result under an injected `dirs` instead of the host's agent directory.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { join } from "node:path";

const { defaultHostDirs } = await import("../src/host-dirs.js");
const { userConfigPath, projectConfigPath } = await import("../src/config.js");
const { indexDir, indexPath } = await import("../src/index-cmd.js");
const { steerStatsPath } = await import("../src/adaptive.js");
const { holdLogPath } = await import("../src/holds.js");
const { loopsPath } = await import("../src/loops.js");
const { prefsStorePath } = await import("../src/prefs.js");
const { rulesLogPath } = await import("../src/rules-log.js");

const savedAgentDir = process.env.PI_CODING_AGENT_DIR;

test("defaultHostDirs: unset env falls back to Pi's agent directory and .pi", () => {
  delete process.env.PI_CODING_AGENT_DIR;
  const dirs = defaultHostDirs();
  assert.equal(dirs.agentDir, join(process.env.HOME ?? "", ".pi", "agent"));
  assert.equal(dirs.configDirName, ".pi");
});

test("defaultHostDirs: explicit path wins, ~ and ~/ expand, blank falls back", () => {
  process.env.PI_CODING_AGENT_DIR = "/opt/agent";
  assert.equal(defaultHostDirs().agentDir, "/opt/agent");
  process.env.PI_CODING_AGENT_DIR = "~";
  assert.equal(defaultHostDirs().agentDir, process.env.HOME);
  process.env.PI_CODING_AGENT_DIR = "~/x";
  assert.equal(defaultHostDirs().agentDir, join(process.env.HOME ?? "", "x"));
  process.env.PI_CODING_AGENT_DIR = "  ";
  assert.equal(defaultHostDirs().agentDir, join(process.env.HOME ?? "", ".pi", "agent"), "blank is unset");
  process.env.PI_CODING_AGENT_DIR = "~/x ";
  assert.equal(defaultHostDirs().agentDir, join(process.env.HOME ?? "", "x"), "surrounding space is trimmed");
});

test("indexDir: PI_WARDEN_INDEX_DIR and PI_CODING_AGENT_DIR keep precedence over injected dirs (R4)", () => {
  process.env.PI_CODING_AGENT_DIR = "/opt/agent";
  const savedIndex = process.env.PI_WARDEN_INDEX_DIR;
  delete process.env.PI_WARDEN_INDEX_DIR;
  const dirs = { agentDir: "/custom/agent", configDirName: ".omp" };
  assert.equal(indexDir(undefined, dirs), join("/opt/agent", "pi-warden", "index"), "PI_CODING_AGENT_DIR wins over dirs");
  process.env.PI_WARDEN_INDEX_DIR = "/idx";
  assert.equal(indexDir(undefined, dirs), join("/idx", "pi-warden", "index"), "PI_WARDEN_INDEX_DIR wins over everything");
  process.env.PI_WARDEN_INDEX_DIR = "   ";
  assert.equal(indexDir(undefined, dirs), join("/opt/agent", "pi-warden", "index"), "blank index var falls to PI_CODING_AGENT_DIR");
  if (savedIndex === undefined) delete process.env.PI_WARDEN_INDEX_DIR; else process.env.PI_WARDEN_INDEX_DIR = savedIndex;
});

test("every path function places its result under the injected dirs", () => {
  delete process.env.PI_CODING_AGENT_DIR;
  const savedIndex = process.env.PI_WARDEN_INDEX_DIR;
  const savedStats = process.env.PI_WARDEN_STEER_STATS;
  const savedDb = process.env.PI_WARDEN_DB;
  delete process.env.PI_WARDEN_INDEX_DIR;
  delete process.env.PI_WARDEN_STEER_STATS;
  delete process.env.PI_WARDEN_DB;
  try {
    const dirs = { agentDir: "/custom/agent", configDirName: ".omp" };
    const project = "/work/repo";
    const underAgent = (p: string) => p.startsWith("/custom/agent/pi-warden/");
    assert.ok(underAgent(userConfigPath(dirs)), userConfigPath(dirs));
    assert.ok(underAgent(steerStatsPath(dirs)), steerStatsPath(dirs));
    assert.ok(underAgent(holdLogPath("s1", new Date(0), dirs)), holdLogPath("s1", new Date(0), dirs));
    assert.ok(underAgent(loopsPath(project, "s1", dirs)), loopsPath(project, "s1", dirs));
    assert.ok(underAgent(prefsStorePath(project, dirs)), prefsStorePath(project, dirs));
    assert.ok(underAgent(rulesLogPath(project, dirs)), rulesLogPath(project, dirs));
    assert.ok(underAgent(indexDir(undefined, dirs)), indexDir(undefined, dirs));
    assert.ok(underAgent(indexPath("global", undefined, undefined, dirs)), indexPath("global", undefined, undefined, dirs));
    assert.ok(underAgent(indexPath("project", project, undefined, dirs)), indexPath("project", project, undefined, dirs));
    // The project config file uses the injected configDirName, not .pi.
    assert.equal(projectConfigPath(project, dirs), join(project, ".omp", "pi-warden.json"));
  } finally {
    if (savedIndex === undefined) delete process.env.PI_WARDEN_INDEX_DIR; else process.env.PI_WARDEN_INDEX_DIR = savedIndex;
    if (savedStats === undefined) delete process.env.PI_WARDEN_STEER_STATS; else process.env.PI_WARDEN_STEER_STATS = savedStats;
    if (savedDb === undefined) delete process.env.PI_WARDEN_DB; else process.env.PI_WARDEN_DB = savedDb;
    if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
  }
});

test("loadConfig, readUserConfig, and setUserSetting honour injected dirs", async () => {
  const { mkdirSync, readFileSync, writeFileSync, rmSync } = await import("node:fs");
  const { loadConfig, readUserConfig, setUserSetting, writeUserConfig } = await import("../src/config.js");
  const temp = mkdtemp();
  const dirs = { agentDir: temp, configDirName: ".omp" };
  try {
    assert.equal(readUserConfig(dirs).enabled, undefined, "no file yet");
    const saved = setUserSetting("enabled", false, dirs);
    assert.equal(saved, join(temp, "pi-warden", "config.json"));
    assert.equal(readFileSync(saved, "utf8").includes('"enabled": false'), true);
    assert.equal(loadConfig({ dirs }).enabled, false);
    // A project file under the injected configDirName is read when trusted.
    mkdirSync(join(temp, "proj", ".omp"), { recursive: true });
    writeFileSync(join(temp, "proj", ".omp", "pi-warden.json"), JSON.stringify({ action: { offTask: { warn: 0.3, steer: 0.4 } } }));
    const withProject = loadConfig({ cwd: join(temp, "proj"), projectTrusted: true, dirs });
    assert.equal(withProject.action.offTask.warn, 0.3, "project file under .omp is read");
    // writeUserConfig round-trips through dirs as well.
    writeUserConfig({ enabled: true }, dirs);
    assert.equal(JSON.parse(readFileSync(saved, "utf8")).enabled, true);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

function mkdtemp(): string {
  return mkdtempSync(join(tmpdir(), "pi-warden-dirs-"));
}

test("indexDir: PI_CODING_AGENT_DIR with ~ expands, blank PI_WARDEN_INDEX_DIR is ignored", async () => {
  const { indexDir } = await import("../src/index-cmd.js");
  const savedAgentDir = process.env.PI_CODING_AGENT_DIR;
  const savedIndex = process.env.PI_WARDEN_INDEX_DIR;
  try {
    process.env.PI_CODING_AGENT_DIR = "~/x";
    delete process.env.PI_WARDEN_INDEX_DIR;
    assert.equal(indexDir(), join(process.env.HOME ?? "", "x", "pi-warden", "index"), "~ expands to the home directory");
    process.env.PI_WARDEN_INDEX_DIR = "   ";
    assert.equal(indexDir(), join(process.env.HOME ?? "", "x", "pi-warden", "index"), "blank PI_WARDEN_INDEX_DIR is not used");
    delete process.env.PI_CODING_AGENT_DIR;
    assert.equal(indexDir(), join(process.env.HOME ?? "", ".pi", "agent", "pi-warden", "index"), "unset env falls back to the Pi default");
  } finally {
    if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
    if (savedIndex === undefined) delete process.env.PI_WARDEN_INDEX_DIR; else process.env.PI_WARDEN_INDEX_DIR = savedIndex;
  }
});

test("legacyDataNotice: gated on the marker beside the data folder; conditional mv + cp", async () => {
  const { legacyDataNotice } = await import("../src/extension.js");
  const pi = { agentDir: "/home/.pi/agent", configDirName: ".pi" };
  const omp = { agentDir: "/home/.omp/agent", configDirName: ".omp" };
  const target = join(omp.agentDir, "pi-warden");
  const legacy = join(pi.agentDir, "pi-warden");
  const exists = new Set<string>([legacy, join(target, "holds.db")]);
  const probe = (p: string) => exists.has(p);
  const message = legacyDataNotice(omp, pi, probe);
  assert.ok(message, "legacy present, marker absent → message");
  // Command is conditional on the target existing and moves it aside non-destructively.
  assert.ok(message.includes(`{ [ ! -e ${target} ] || mv ${target} ${target}.before-migration; } && cp -R ${legacy} ${target}`), "exact conditional mv + cp command");
  assert.ok(message.includes("close all Pi and oh-my-pi sessions"), "keeps the sessions-first warning");
  assert.ok(message.includes(".pi/pi-warden.json to .omp/pi-warden.json"), "names the project-file copy");
  // Marker beside the data folder → silent.
  exists.add(join(omp.agentDir, ".pi-warden-migration-notice-shown"));
  assert.equal(legacyDataNotice(omp, pi, probe), undefined, "marker beside the folder silences it");
  // No legacy data → silent.
  exists.delete(legacy);
  assert.equal(legacyDataNotice(omp, pi, probe), undefined, "no legacy data");
  // Pi host → silent (dirs equal the default), whatever exists.
  exists.add(legacy);
  assert.equal(legacyDataNotice(pi, pi, probe), undefined, "Pi host never migrates");
});

