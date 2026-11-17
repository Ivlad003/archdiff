// Which archdiff the extension runs, and what to start for it. In order:
// the command the settings name, the one the workspace installed
// (`node_modules/.bin/archdiff`), the one on the PATH, and last
// `npx --yes @ivlad003/archdiff`, which fetches it on first use.
//
// On Windows a command npm installed is a batch file (`archdiff.cmd`),
// which Node does not start without a shell — and a shell would read the
// workspace's path for its own signs. So a shim is read for what it runs,
// a script handed to node, and node is started with that script in its
// place; npm's own `npx.cmd` names its script alike. `src/agent-command.ts`
// of archdiff does the same for the agents; this is the extension's copy,
// since the extension ships without archdiff and runs whichever is there.
//
// Pure: the computer is a `Machine` (its platform, its environment, what is
// a file, a file's text), so the tests name one. Entry points:
// `findArchdiff`, `Start`, `Machine`, `Found`, `PACKAGE`.

import { posix, win32 } from "node:path";

/** The package `npx` fetches when no archdiff is installed. */
export const PACKAGE = "@ivlad003/archdiff";

/** What the search reads of the computer. */
export interface Machine {
  platform: string;
  env: Readonly<Record<string, string | undefined>>;
  isFile(path: string): boolean;
  /** The text of a file (a shim's). */
  read(path: string): string;
}

/** What to start: the program, the arguments that come before archdiff's own, and where it was found. */
export interface Start {
  file: string;
  args: string[];
  from: "setting" | "workspace" | "path" | "npx";
}

export type Found = { ok: true; start: Start } | { ok: false; problem: string };

/** What Windows starts by a bare name, in the order tried: a program before a batch file of the same name. */
const WINDOWS_EXTENSIONS = [".exe", ".com", ".cmd", ".bat"];

const BATCH = /\.(cmd|bat)$/i;

/** The path functions of the machine: a test names a Windows machine on any system. */
function pathOf(machine: Machine): typeof posix {
  return machine.platform === "win32" ? win32 : posix;
}

/** The names a command may have on disk: its own, and on Windows — when it names no extension — one per extension Windows starts. */
function namesOf(command: string, machine: Machine): string[] {
  if (machine.platform !== "win32" || WINDOWS_EXTENSIONS.includes(pathOf(machine).extname(command).toLowerCase())) return [command];

  return WINDOWS_EXTENSIONS.map((extension) => command + extension);
}

/** The file of a command in a directory, or null. */
function inDirectory(directory: string, command: string, machine: Machine): string | null {
  return namesOf(command, machine).map((name) => pathOf(machine).join(directory, name)).find((file) => machine.isFile(file)) ?? null;
}

/** The file of a command on the PATH, or null. */
function onPath(command: string, machine: Machine): string | null {
  const path = pathOf(machine);

  for (const directory of (machine.env["PATH"] ?? machine.env["Path"] ?? "").split(path.delimiter)) {
    const found = directory === "" ? null : inDirectory(directory, command, machine);

    if (found) return found;
  }

  return null;
}

/**
 * What a batch file of npm runs: the file a package's shim names beside itself (the last `"%dp0%\…" %*` or
 * `"%~dp0\…" %*` of its text; pnpm and Yarn write theirs alike) with the program it hands that file to (`node`;
 * null when the file is a program itself), or the script npm's own `npx.cmd` and `npm.cmd` set for node
 * (`SET "NPX_CLI_JS=%~dp0\…"`). Null for any other batch file.
 */
function targetOfBatch(text: string): { target: string; program: string | null } | null {
  const call = [...text.matchAll(/"%(?:~dp0|dp0%)\\([^"\r\n]+)"[ \t]+%\*/g)].at(-1);

  if (!call) {
    const own = text.match(/SET "NP[MX]_CLI_JS=%~dp0\\([^"\r\n]+)"/i);

    return own ? { target: own[1]!, program: "node" } : null;
  }

  // The word before the file on its line: the program, by its name, by a path, or as the variable the shim set.
  const before = text.slice(text.lastIndexOf("\n", call.index) + 1, call.index).trimEnd();
  const word = before.match(/(?:"([^"]+)"|([^\s"&|()]+))$/);
  const named = word?.[1] ?? word?.[2] ?? null;

  if (named === null) return { target: call[1]!, program: null };
  const program = named === "%_prog%" ? (text.match(/SET "_prog=([^"%\r\n]+)"/i)?.[1] ?? "node") : named;

  return { target: call[1]!, program: program.replace(/^@/, "").split(/[\\/]/).at(-1)!.replace(/\.exe$/i, "").toLowerCase() };
}

/**
 * What to start for a file found: the file itself, or — for a batch file on Windows — what the batch file runs: a
 * program, or node with a script (the node beside the batch file when there is one, as npm chooses, else the PATH's).
 */
function startOf(file: string, from: Start["from"], machine: Machine): Found {
  if (machine.platform !== "win32" || !BATCH.test(file)) return { ok: true, start: { file, args: [], from } };
  const path = pathOf(machine);
  const batch = targetOfBatch(machine.read(file));

  if (batch === null) return { ok: false, problem: `${file} is a batch file that is no shim of npm: name the program it runs in the setting archdiff.command` };
  const target = path.join(path.dirname(file), ...batch.target.split(/[\\/]/));

  if (!machine.isFile(target)) return { ok: false, problem: `${file} runs ${target}, which is not there` };

  if (batch.program === null) return /\.(exe|com)$/i.test(target) ? { ok: true, start: { file: target, args: [], from } } : { ok: false, problem: `${file} runs ${target}, which is no program: name the program that runs it in the setting archdiff.command` };

  if (batch.program !== "node") return { ok: false, problem: `${file} runs ${target} with ${batch.program}, not with node: name the program in the setting archdiff.command` };
  const node = inDirectory(path.dirname(file), "node.exe", machine) ?? onPath("node.exe", machine);

  return node === null ? { ok: false, problem: `${file} runs ${target} with node, which is not on the PATH` } : { ok: true, start: { file: node, args: [target], from } };
}

/**
 * The archdiff to run for a workspace: `configured` (the setting, a path or a name on the PATH; empty or null for
 * none), else the workspace's own, else the PATH's, else `npx`. The problem names what is missing: a configured
 * command that is nowhere, or neither archdiff nor npx on this computer.
 */
export function findArchdiff(workspace: string, configured: string | null, machine: Machine): Found {
  const path = pathOf(machine);

  if (configured !== null && configured.trim() !== "") {
    const command = configured.trim();
    const named = /[\\/]/.test(command) ? (namesOf(path.resolve(workspace, command), machine).find((file) => machine.isFile(file)) ?? null) : onPath(command, machine);

    return named === null ? { ok: false, problem: `the setting archdiff.command names ${command}, which is ${/[\\/]/.test(command) ? "not a file" : "not on the PATH"}` } : startOf(named, "setting", machine);
  }

  const own = inDirectory(path.join(workspace, "node_modules", ".bin"), "archdiff", machine);

  if (own) return startOf(own, "workspace", machine);
  const installed = onPath("archdiff", machine);

  if (installed) return startOf(installed, "path", machine);
  const npx = onPath("npx", machine);

  if (npx === null) return { ok: false, problem: `archdiff is not installed (npm install --save-dev ${PACKAGE}), and npx is not on the PATH to fetch it` };
  const start = startOf(npx, "npx", machine);

  return start.ok ? { ok: true, start: { ...start.start, args: [...start.start.args, "--yes", PACKAGE] } } : start;
}
