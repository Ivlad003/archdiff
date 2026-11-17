// Where the command of an agent is on this computer, and what to start
// for it. A name is looked for in the directories of PATH and then where
// the agents' own installers put them for the user (`~/.local/bin`,
// `~/.opencode/bin`, npm's directory on Windows): a server started from
// a desktop application often has a PATH without them.
//
// On Windows a name stands for a program (`claude.exe`) or for a batch
// file (`codex.cmd`, the shim npm writes for a package's command). Node
// starts a program and refuses a batch file, and a batch file could not
// take a task anyway: cmd.exe ends an argument at its first line break.
// So a shim is read for what it runs — a program, or a script handed to
// node — and that is started in its place, with the task as one argument,
// whatever it holds.
//
// Entry points: `commandStart`, `findCommand`, `shimTarget`, `userBins`.

import { readFileSync, statSync } from "node:fs";
import { delimiter, dirname, extname, join } from "node:path";
import { userHome } from "./home.ts";
import { ok, wrong, type Result } from "./result.ts";

/** What to start for a command: the program, and the arguments that come before the command's own. */
export interface CommandStart {
  file: string;
  args: string[];
}

const WINDOWS = process.platform === "win32";

/** What Windows starts by a bare name, in the order tried: a program before a batch file of the same name. */
const WINDOWS_EXTENSIONS = [".exe", ".com", ".cmd", ".bat"];

const BATCH = /\.(cmd|bat)$/i;

function isFile(path: string): boolean {
  return statSync(path, { throwIfNoEntry: false })?.isFile() ?? false;
}

/** Where the agents are installed for the user alone: Claude Code's and Cursor's installers, OpenCode's, and npm's global commands on Windows. */
export function userBins(env: NodeJS.ProcessEnv = process.env): string[] {
  const home = userHome(env);

  return [join(home, ".local", "bin"), join(home, ".opencode", "bin"), ...(WINDOWS ? [join(home, "AppData", "Roaming", "npm")] : [])];
}

/** The names a command may have on disk: its own, and on Windows — when it names no extension — one per extension Windows starts. */
function namesOf(command: string): string[] {
  if (!WINDOWS || WINDOWS_EXTENSIONS.includes(extname(command).toLowerCase())) return [command];

  return WINDOWS_EXTENSIONS.map((extension) => command + extension);
}

/** The file of a command: a path as it is given, a name in the directories of PATH and then in `userBins`; null when it is nowhere. */
export function findCommand(command: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const names = namesOf(command);

  if (command.includes("/") || command.includes("\\")) return names.find(isFile) ?? null;

  for (const directory of [...(env["PATH"] ?? env["Path"] ?? "").split(delimiter), ...userBins(env)]) {
    if (directory === "") continue;
    const found = names.map((name) => join(directory, name)).find(isFile);

    if (found) return found;
  }

  return null;
}

/**
 * What a shim of npm runs (pnpm and Yarn write theirs alike): the file it names beside itself — the last
 * `"%dp0%\…" %*` or `"%~dp0\…" %*` of its text — and the program it hands that file to (`node`, `sh`), null when the
 * file is a program itself. Null for a batch file that is no such shim.
 */
export function shimTarget(text: string): { target: string; program: string | null } | null {
  const call = [...text.matchAll(/"%(?:~dp0|dp0%)\\([^"\r\n]+)"[ \t]+%\*/g)].at(-1);

  if (!call) return null;
  // The word before the file on its line: the program, by its name, by a path, or as the variable the shim set.
  const before = text.slice(text.lastIndexOf("\n", call.index) + 1, call.index).trimEnd();
  const word = before.match(/(?:"([^"]+)"|([^\s"&|()]+))$/);
  const named = word?.[1] ?? word?.[2] ?? null;

  if (named === null) return { target: call[1]!, program: null };
  const program = named === "%_prog%" ? (text.match(/SET "_prog=([^"%\r\n]+)"/i)?.[1] ?? "node") : named;

  return { target: call[1]!, program: program.replace(/^@/, "").split(/[\\/]/).at(-1)!.replace(/\.exe$/i, "").toLowerCase() };
}

/**
 * What to start for `command`: the file found for it, or — for a shim on Windows — what the shim runs. A problem
 * names what is missing: the command itself, the file its shim names, or a batch file that is no shim (it cannot
 * take a task of several lines, so the program it runs has to be named instead).
 */
export function commandStart(command: string, env: NodeJS.ProcessEnv = process.env): Result<CommandStart> {
  const file = findCommand(command, env);

  if (file === null) return wrong(command.includes("/") || command.includes("\\") ? `${command} is not a file` : `\`${command}\` is not on the PATH, nor in ${userBins(env).map((directory) => `~${directory.slice(userHome(env).length)}`).join(", ")}`);

  if (!WINDOWS || !BATCH.test(file)) return ok({ file, args: [] });
  const shim = shimTarget(readFileSync(file, "utf8"));

  if (!shim) return wrong(`${file} is a batch file, which cannot take a task of several lines: name the program it runs instead`);
  const target = join(dirname(file), ...shim.target.split(/[\\/]/));

  if (!isFile(target)) return wrong(`${file} runs ${target}, which is not there`);

  if (shim.program === null) return /\.(exe|com)$/i.test(target) ? ok({ file: target, args: [] }) : wrong(`${file} runs ${target}, which is no program: name the program that runs it instead`);

  // npm's own choice: the node beside the shim when there is one; else the node this server runs on, which is surely there.
  if (shim.program === "node") return ok({ file: isFile(join(dirname(file), "node.exe")) ? join(dirname(file), "node.exe") : process.execPath, args: [target] });
  const program = findCommand(shim.program, env);

  return program !== null && !BATCH.test(program) ? ok({ file: program, args: [target] }) : wrong(`${file} runs ${target} with \`${shim.program}\`, which ${program === null ? "is not installed here" : "is a batch file itself"}`);
}
