// The user's own directory on this computer: where archdiff keeps the
// settings that are the user's and no repository's (settings.ts), and
// where it looks for the coding agents installed for the user alone
// (agent-command.ts). `ARCHDIFF_HOME` names another one: the tests give
// every server a directory of its own, so that no test reads the keys or
// finds the agents of the person who runs it.
//
// Entry point: `userHome`.

import { homedir } from "node:os";

/** The directory taken for the user's home: `ARCHDIFF_HOME` when it is set, else the system's. */
export function userHome(env: NodeJS.ProcessEnv = process.env): string {
  return env["ARCHDIFF_HOME"] || homedir();
}
