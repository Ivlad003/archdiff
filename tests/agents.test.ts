// The agents of this computer and the user's settings: what is started
// for an agent's command (a name on the PATH or where agents are installed
// for the user; on Windows what a shim of npm runs), a run through such a
// command — the task whole, a stop that ends what the agent started — the
// settings file and its rules, and the settings through the HTTP API: the
// program, the model and the keys reach the agent, and a key's value never
// comes back.
//
// Entry point: run by `npm test`.

import assert from "node:assert/strict";
import { cpSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AgentRunner, AGENTS, installedAgents, type AgentRun, type AgentSpec } from "../src/agent.ts";
import { commandStart, findCommand, shimTarget, userBins } from "../src/agent-command.ts";
import type { JsonValue } from "../src/json.ts";
import { agentSpecs, changedSettings, NO_SETTINGS, readSettings, settingsFrom, settingsPath, writeSettings } from "../src/settings.ts";
import { withTempDir } from "./temp-dir.ts";
import { fakeCommand, homeOf, startWeb, withOwnServer } from "./web-server.ts";

const root = join(import.meta.dirname, "..");
const fixture = join(root, "tests/fixtures/sample");
const WINDOWS = process.platform === "win32";

/** The shim npm writes on Windows for a package's command, ending in `call`. */
function npmShim(call: string, program = "node"): string {
  return ["@ECHO off", "GOTO start", ":find_dp0", "SET dp0=%~dp0", "EXIT /b", ":start", "SETLOCAL", "CALL :find_dp0", "", `IF EXIST "%dp0%\\${program}.exe" (`, `  SET "_prog=%dp0%\\${program}.exe"`, ") ELSE (", `  SET "_prog=${program}"`, "  SET PATHEXT=%PATHEXT:;.JS;=;%", ")", "", call, ""].join("\r\n");
}

test("a shim of npm is read for what it runs: a script handed to node, or a program itself; a batch file of another kind is none", () => {
  assert.deepEqual(shimTarget(npmShim('endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*')), { target: "node_modules\\@openai\\codex\\bin\\codex.js", program: "node" });
  // A script of another interpreter: the program the shim set.
  assert.deepEqual(shimTarget(npmShim('endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\tool\\run.sh" %*', "sh")), { target: "node_modules\\tool\\run.sh", program: "sh" });
  // A package whose command is a program: nothing stands before it.
  assert.deepEqual(shimTarget(["@ECHO off", "GOTO start", ":find_dp0", "SET dp0=%~dp0", "EXIT /b", ":start", "SETLOCAL", "CALL :find_dp0", '"%dp0%\\node_modules\\opencode-ai\\bin\\opencode.exe"   %*', ""].join("\r\n")), { target: "node_modules\\opencode-ai\\bin\\opencode.exe", program: null });
  // The older form, which pnpm and Yarn still write: the program by its name, or by a path beside the shim.
  const older = ['@IF EXIST "%~dp0\\node.exe" (', '  "%~dp0\\node.exe"  "%~dp0\\node_modules\\foo\\bin\\foo.js" %*', ") ELSE (", "  @SETLOCAL", "  @SET PATHEXT=%PATHEXT:;.JS;=;%", '  node  "%~dp0\\node_modules\\foo\\bin\\foo.js" %*', ")", ""];
  assert.deepEqual(shimTarget(older.join("\r\n")), { target: "node_modules\\foo\\bin\\foo.js", program: "node" });
  assert.deepEqual(shimTarget(older.slice(0, 2).join("\n")), { target: "node_modules\\foo\\bin\\foo.js", program: "node" });
  assert.equal(shimTarget("@echo off\r\npowershell -File agent.ps1 %*\r\n"), null);
});

test("a command is found on the PATH, then where agents are installed for the user; a path is a file or nothing", () =>
  withTempDir("archdiff-command-", (dir) => {
    const file = WINDOWS ? "agent-x.exe" : "agent-x";
    const onPath = join(dir, "bin");
    const home = join(dir, "home");
    const installed = join(home, ".local", "bin");
    mkdirSync(onPath);
    mkdirSync(installed, { recursive: true });
    const env = { PATH: onPath, ARCHDIFF_HOME: home };
    assert.deepEqual(userBins(env).slice(0, 2), [installed, join(home, ".opencode", "bin")]);
    // Nowhere: the problem names where it was looked for.
    const nowhere = commandStart("agent-x", env);
    assert.ok(!nowhere.ok && nowhere.problem.message.includes("is not on the PATH") && nowhere.problem.message.includes(join("~", ".local", "bin")), JSON.stringify(nowhere));
    // Installed for the user and not on the PATH (a server started from a desktop application): found.
    writeFileSync(join(installed, file), "");
    assert.deepEqual(commandStart("agent-x", env), { ok: true, value: { file: join(installed, file), args: [] } });
    // The PATH goes first.
    writeFileSync(join(onPath, file), "");
    assert.equal(findCommand("agent-x", env), join(onPath, file));
    // A directory of that name is no command.
    mkdirSync(join(onPath, WINDOWS ? "dir-x.exe" : "dir-x"));
    assert.equal(findCommand("dir-x", env), null);
    assert.equal(findCommand(join(onPath, "agent-x"), env), join(onPath, file));
    const missing = commandStart(join(onPath, "nope"), env);
    assert.ok(!missing.ok && missing.problem.message.endsWith("is not a file"), JSON.stringify(missing));
  }));

test("on Windows a shim is started as what it runs — a program before a batch file of its name — and a batch file that is no shim is refused, saying why", { skip: !WINDOWS && "the batch files of Windows" }, () =>
  withTempDir("archdiff-shim-", (dir) => {
    const script = join(dir, "node_modules", "fake-agent", "fake-agent.mjs");
    const started = { ok: true, value: { file: process.execPath, args: [script] } };
    // By its path without the extension, and by its name on the PATH.
    assert.deepEqual(commandStart(fakeCommand(dir, "fake-agent", join(root, "tests/fixtures/fake-agent.mjs"))), started);
    assert.deepEqual(commandStart("fake-agent", { PATH: dir, ARCHDIFF_HOME: dir }), started);
    assert.deepEqual(commandStart(join(dir, "fake-agent.cmd")), started);
    // A shim of a program is the program.
    mkdirSync(join(dir, "node_modules", "tool", "bin"), { recursive: true });
    writeFileSync(join(dir, "node_modules", "tool", "bin", "tool.exe"), "");
    writeFileSync(join(dir, "tool.cmd"), '@ECHO off\r\n"%dp0%\\node_modules\\tool\\bin\\tool.exe"   %*\r\n');
    assert.deepEqual(commandStart(join(dir, "tool")), { ok: true, value: { file: join(dir, "node_modules", "tool", "bin", "tool.exe"), args: [] } });
    writeFileSync(join(dir, "tool.exe"), "");
    assert.deepEqual(commandStart(join(dir, "tool")), { ok: true, value: { file: join(dir, "tool.exe"), args: [] } });
    // What cannot be started says why.
    writeFileSync(join(dir, "gone.cmd"), '"%dp0%\\node_modules\\gone\\gone.exe" %*\r\n');
    const gone = commandStart(join(dir, "gone"));
    assert.ok(!gone.ok && gone.problem.message.endsWith("which is not there"), JSON.stringify(gone));
    writeFileSync(join(dir, "own.bat"), "@echo off\r\npowershell -File agent.ps1 %*\r\n");
    const own = commandStart(join(dir, "own"));
    assert.ok(!own.ok && own.problem.message.includes("is a batch file, which cannot take a task of several lines"), JSON.stringify(own));
    // An agent that cannot start is offered as not installed, with the reason; the runner refuses it the same.
    const spec: AgentSpec = { name: "own", label: "Own", command: [join(dir, "own")], resumeFlag: null, protocol: "stream-json" };
    assert.deepEqual(installedAgents([spec]).map((agent) => [agent.installed, agent.path, agent.problem === own.problem.message]), [[false, null, true]]);
    assert.throws(() => new AgentRunner(dir).start(spec, "x", null), /Own cannot start: .*batch file/);
  }));

/** The events of a run as lines, once it has ended; null when it has not within `ms`. */
function ended(run: AgentRun, ms = 20_000): Promise<string[] | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    run.subscribe(0, (event) => {
      if (event.kind !== "exit") return;
      clearTimeout(timer);
      resolve(run.events.map((each) => `${each.kind}: ${each.text}`));
    });
  });
}

test("a run through an installed command carries the task whole, the model and the keys; no key shows in its events; a stop ends what the agent started", () =>
  withTempDir("archdiff-run-", async (dir) => {
    const specOf = (script: string): AgentSpec => ({ name: "fake", label: "Fake", command: [fakeCommand(dir, script.replace(".mjs", ""), join(root, "tests/fixtures", script))], resumeFlag: "--resume", protocol: "stream-json" });
    const runner = new AgentRunner(dir);
    // What a shell would cut, expand or join: the task is one argument, as it was written.
    const task = 'Line one "quoted" & more | %PATH% ^ <tag> $HOME\nline two: it\'s 100% done\n\n  - a list item\nshow-env: ARCHDIFF_TEST_KEY';
    const events = await ended(runner.start({ ...specOf("fake-env.mjs"), model: "m-1", modelArgs: ["--model", "{model}"], env: { ARCHDIFF_TEST_KEY: "secret-value-123" }, secrets: ["secret-value-123"] }, task, null));
    assert.ok(events, "the run ended");
    assert.ok(events.includes('text: args: ["--model","m-1"]'), JSON.stringify(events));
    assert.ok(events.includes(`text: task: ${task.length} chars, 5 lines`), JSON.stringify(events));
    assert.ok(events.includes("text: ARCHDIFF_TEST_KEY=[•••]"), JSON.stringify(events));
    assert.ok(!events.join("\n").includes("secret-value-123"));

    // On Windows a signal ends one process: the agent's own child would hold the run open for its minute.
    if (WINDOWS) {
      const run = runner.start(specOf("fake-tree.mjs"), "wait", null);
      await new Promise<void>((resolve) => run.subscribe(0, (event) => event.kind === "init" && resolve()));
      run.stop();
      assert.ok(await ended(run, 15_000), "the run ended with the process the agent started");
    }
  }));

test("the settings are kept in the user's own file, for the user alone, and refuse what is no agent, model or key", () =>
  withTempDir("archdiff-settings-", (home) => {
    const env = { ARCHDIFF_HOME: home };
    const file = join(home, ".archdiff", "settings.json");
    assert.equal(settingsPath(env), file);
    assert.deepEqual(readSettings(env), { ok: true, value: NO_SETTINGS });
    // What is empty says nothing and is left out.
    const settings = settingsFrom({ agents: { claude: { command: "/opt/claude", model: "sonnet", openrouter: true }, codex: { model: "" } }, custom: [{ name: "mine", command: ["node", "agent.mjs"], resume: "--resume" }], keys: { OPENROUTER_API_KEY: "sk-or-test-0000000000" } });
    assert.deepEqual(settings, { agents: { claude: { command: "/opt/claude", model: "sonnet", openrouter: true } }, custom: [{ name: "mine", command: ["node", "agent.mjs"], protocol: "stream-json", resume: "--resume" }], keys: { OPENROUTER_API_KEY: "sk-or-test-0000000000" } });
    writeSettings(settings, env);
    assert.deepEqual(readSettings(env), { ok: true, value: settings });

    if (!WINDOWS) assert.equal(statSync(file).mode & 0o777, 0o600);

    const refusals: [JsonValue, string][] = [
      [{ agents: { gemini: {} } }, 'not "gemini"'],
      [{ agents: { codex: { openrouter: true } } }, "Claude Code's alone"],
      [{ agents: { claude: { model: "a b" } } }, "a model's name"],
      [{ custom: [{ name: "claude", command: ["x"] }] }, "is there already"],
      [{ custom: [{ name: "mine", command: ["x"] }, { name: "mine", command: ["y"] }] }, "is there already"],
      [{ custom: [{ name: "mine", command: [] }] }, 'needs a "command"'],
      [{ custom: [{ name: "mine", command: ["x"], protocol: "telnet" }] }, '"protocol"'],
      // A variable that would change what a process loads is no key.
      [{ keys: { NODE_OPTIONS: "--require ./x.js" } }, "…_KEY or …_TOKEN"],
      [{ keys: { SOME_API_KEY: "two\nlines" } }, "one line"],
    ];

    for (const [wrong, says] of refusals) assert.throws(() => settingsFrom(wrong), (error: Error) => error.message.startsWith("settings: ") && error.message.includes(says), says);

    // A change from the page: a key set or forgotten by its name, the rest as it was.
    const changed = changedSettings(settings, { keys: { OPENROUTER_API_KEY: null, CURSOR_API_KEY: "cur-test-000000" } });
    assert.deepEqual(changed, { ...settings, keys: { CURSOR_API_KEY: "cur-test-000000" } });
    assert.deepEqual(changedSettings(settings, { custom: [] }), { ...settings, custom: [] });
    assert.throws(() => changedSettings(settings, { keys: { PATH: "/tmp" } }), /_KEY or …_TOKEN/);
    // A file that does not read is a problem that names it, not empty settings.
    writeFileSync(file, "{ not json");
    const broken = readSettings(env);
    assert.ok(!broken.ok && broken.problem.message.startsWith(file), JSON.stringify(broken));
  }));

test("the settings place the agents: the program, the model, the keys in the environment; Claude Code through OpenRouter runs on OpenRouter's key and is blocked without one", () => {
  const key = "sk-or-test-0000000000";
  const settings = settingsFrom({ agents: { claude: { openrouter: true, model: "anthropic/claude-x" }, codex: { command: "/opt/codex" } }, custom: [{ name: "mine", command: ["node", "agent.mjs"] }], keys: { OPENROUTER_API_KEY: key, ANTHROPIC_API_KEY: "sk-ant-test-00000000" } });
  const specs = agentSpecs(settings, null, {});
  assert.deepEqual(specs.map((spec) => spec.name), ["claude", "cursor", "codex", "opencode", "mine"]);
  const [claude, , codex, , mine] = specs;
  assert.equal(claude!.model, "anthropic/claude-x");
  // Anthropic's own key is emptied for it: Claude Code would take it in place of OpenRouter's.
  assert.deepEqual(claude!.env, { OPENROUTER_API_KEY: key, ANTHROPIC_API_KEY: "", ANTHROPIC_BASE_URL: "https://openrouter.ai/api", ANTHROPIC_AUTH_TOKEN: key });
  assert.deepEqual(claude!.secrets, [key]);
  assert.equal(claude!.blocked, undefined);
  // The program placed stands in both of Codex's commands; the other agents get the keys as they are.
  assert.equal(codex!.command[0], "/opt/codex");
  assert.equal(codex!.resumeCommand?.[0], "/opt/codex");
  assert.deepEqual(codex!.command.slice(1), AGENTS.codex.command.slice(1));
  assert.deepEqual(codex!.env, settings.keys);
  assert.deepEqual(mine!.env, settings.keys);
  // Without a key there is nothing to run on: said, not tried. A key of the server's own environment serves.
  const through = settingsFrom({ agents: { claude: { openrouter: true } } });
  assert.match(agentSpecs(through, null, {})[0]!.blocked ?? "", /no OPENROUTER_API_KEY is set/);
  assert.equal(agentSpecs(through, null, { OPENROUTER_API_KEY: "sk-or-env-0000000000" })[0]!.env?.["ANTHROPIC_AUTH_TOKEN"], "sk-or-env-0000000000");
  // Nothing set: the built-in agents as they are.
  assert.deepEqual(agentSpecs(NO_SETTINGS, null, {}), Object.values(AGENTS));
  // The agent given to the server keeps its place; one of its name in the settings yields to it.
  const given: AgentSpec = { name: "mine", label: "mine", command: ["given"], resumeFlag: null, protocol: "codex" };
  assert.deepEqual(agentSpecs(settings, given, {}).filter((spec) => spec.name === "mine").map((spec) => spec.command), [["given"]]);
  // A blocked agent is offered as not installed with its reason, though its program is there.
  const offered = installedAgents([{ ...AGENTS.claude, command: [process.execPath], blocked: "no key" }, { ...AGENTS.codex, command: [join(root, "nowhere")] }]);
  assert.deepEqual(offered.map((agent) => [agent.installed, agent.path, agent.problem]), [[false, process.execPath, "no key"], [false, null, `${join(root, "nowhere")} is not a file`]]);
});

interface Shown {
  file: string;
  problem: string | null;
  agents: { name: string; from: string; installed: boolean; path: string | null; problem: string | null; command: string | string[] | null; model: string | null; openrouter: boolean | null }[];
  keys: { name: string; hint: string; empty: boolean }[];
  known: { name: string; environment: boolean }[];
  error?: string;
}

test("the settings through the API: an agent placed by its program runs with its model and the keys, and a key's value never comes back", () =>
  withOwnServer(
    "archdiff-settings-api-",
    () => undefined,
    async (origin, dir) => {
      const file = join(homeOf(dir), ".archdiff", "settings.json");
      const post = async (change: unknown): Promise<{ status: number; text: string; body: Shown }> => {
        const response = await fetch(`${origin}/api/settings`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(change) });
        const text = await response.text();

        return { status: response.status, text, body: JSON.parse(text) as Shown };
      };
      const get = async (): Promise<Shown> => (await (await fetch(`${origin}/api/settings`)).json()) as Shown;
      // Nothing kept yet, and none of the agents on this server's PATH or in its home.
      const first = await get();
      assert.equal(first.file, file);
      assert.deepEqual(first.agents.map((agent) => [agent.name, agent.from, agent.installed]), [["claude", "built-in", false], ["cursor", "built-in", false], ["codex", "built-in", false], ["opencode", "built-in", false]]);
      assert.deepEqual(first.keys, []);
      assert.deepEqual(first.known.map((key) => key.name).slice(0, 2), ["OPENROUTER_API_KEY", "ANTHROPIC_API_KEY"]);

      // Claude Code placed at a program, with a model, through OpenRouter: it waits for the key, and says so.
      const placed = await post({ agents: { claude: { command: fakeCommand(dir, "placed-claude", join(root, "tests/fixtures/fake-env.mjs")), model: "anthropic/claude-x", openrouter: true } } });
      assert.equal(placed.status, 200, placed.text);
      assert.equal(placed.body.agents[0]!.installed, false);
      assert.match(placed.body.agents[0]!.problem ?? "", /no OPENROUTER_API_KEY is set/);
      const key = "sk-or-test-1234567890abcdef";
      const keyed = await post({ keys: { OPENROUTER_API_KEY: key } });
      assert.deepEqual(keyed.body.keys, [{ name: "OPENROUTER_API_KEY", hint: "…cdef", empty: false }]);
      assert.ok(keyed.body.agents[0]!.installed, keyed.text);
      assert.ok(!keyed.text.includes(key) && !(await (await fetch(`${origin}/api/settings`)).text()).includes(key), "the key's value is not sent back");
      assert.equal((JSON.parse(readFileSync(file, "utf8")) as { keys: Record<string, string> }).keys["OPENROUTER_API_KEY"], key);
      // The Chat tab is offered it, the first installed.
      assert.equal(((await (await fetch(`${origin}/api/agents`)).json()) as { default: string | null }).default, "claude");

      const started = (await (await fetch(`${origin}/api/agent/run`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ view: "layers", prompt: "show-env: OPENROUTER_API_KEY,ANTHROPIC_BASE_URL,ANTHROPIC_AUTH_TOKEN,ANTHROPIC_API_KEY", resume: null, agent: "claude" }) })).json()) as { id: string };
      const stream = await (await fetch(`${origin}/api/agent/events?id=${started.id}`)).text();
      const texts = stream.split("\n\n").filter((chunk) => chunk.startsWith("data: ")).map((chunk) => (JSON.parse(chunk.slice(6)) as { text: string }).text);
      assert.ok(texts.some((text) => text.startsWith("args: ") && text.includes('"--model","anthropic/claude-x"')), stream);
      assert.ok(texts.includes("ANTHROPIC_BASE_URL=[https://openrouter.ai/api]") && texts.includes("ANTHROPIC_AUTH_TOKEN=[•••]") && texts.includes("OPENROUTER_API_KEY=[•••]"), stream);
      // Emptied: Windows hands an empty variable on as none.
      assert.ok(texts.includes("ANTHROPIC_API_KEY=[]") || texts.includes("ANTHROPIC_API_KEY=(unset)"), stream);
      assert.ok(!stream.includes(key), "the key's value is in no event");

      // An agent of the user's own is offered beside the others; a wrong change is refused whole.
      const own = await post({ custom: [{ name: "mine", command: [process.execPath, join(root, "tests/fixtures/fake-agent.mjs")], resume: "--resume" }] });
      assert.deepEqual(own.body.agents.map((agent) => [agent.name, agent.from, agent.installed]).at(-1), ["mine", "settings", true]);
      const refused = await post({ keys: { NODE_OPTIONS: "--require ./x.js" }, custom: [] });
      assert.equal(refused.status, 400);
      assert.match(refused.body.error ?? "", /_KEY or …_TOKEN/);
      const kept = await get();
      assert.deepEqual([kept.keys.length, kept.agents.length], [1, 5]);
      assert.deepEqual((await post({ keys: { OPENROUTER_API_KEY: null } })).body.keys, []);

      // A file broken by hand is said, and not written over.
      writeFileSync(file, "{ broken");
      assert.ok(((await get()).problem ?? "").startsWith(file));
      assert.equal((await post({ keys: { OPENAI_API_KEY: "sk-test-000000000000" } })).status, 400);
      assert.equal(readFileSync(file, "utf8"), "{ broken");
    },
  ));

test("the settings are read and changed on the computer archdiff runs on: another address is refused, however the server is bound", async (t) => {
  const address = Object.values(networkInterfaces()).flatMap((addresses) => addresses ?? []).find((item) => item.family === "IPv4" && !item.internal)?.address;

  if (!address) return t.skip("no address but this computer's own");

  await withTempDir("archdiff-settings-far-", async (dir) => {
    cpSync(fixture, dir, { recursive: true });
    const started = startWeb(dir, ["--no-watch", "--host", "0.0.0.0"]);

    try {
      const port = new URL(await started.origin).port;
      assert.equal((await fetch(`http://127.0.0.1:${port}/api/settings`)).status, 200);
      const far = await fetch(`http://${address}:${port}/api/settings`);
      assert.equal(far.status, 403);
      assert.match(((await far.json()) as { error: string }).error, /on the computer archdiff runs on/);
      assert.equal((await fetch(`http://${address}:${port}/api/settings`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ keys: { OPENAI_API_KEY: "sk-test-000000000000" } }) })).status, 403);
    } finally {
      started.server.kill();
    }
  });
});
