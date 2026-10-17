// The result of an operation at an I/O edge: a value, or a problem that
// names what went wrong and how each edge reports it — the exit code of
// the CLI (1: findings, 2: a wrong call or an I/O error) and the status of
// the HTTP API (400: the request, 404: not found, 500: the server). The
// core throws nothing on bad input; the edges turn a `Problem` into text
// once, in one place each (`fail` in cli.ts, `problem` in routes).
//
// Entry points: `Result`, `Problem`, `ok`, `wrong`, `attempt`.

export interface Problem {
  message: string;
  /** The exit code of the CLI: 1 findings or differences, 2 a wrong invocation or an I/O error. */
  exit: 1 | 2;
  /** The status of the HTTP API. */
  status: 400 | 404 | 500;
}

export type Result<T> = { ok: true; value: T } | { ok: false; problem: Problem };

export function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

/** A problem of the request or the input: exit 2, status 400 unless said otherwise. */
export function wrong(message: string, status: Problem["status"] = 400, exit: Problem["exit"] = 2): Result<never> {
  return { ok: false, problem: { message, exit, status } };
}

/** Runs `fn`; a thrown error becomes a problem with its message (an I/O failure: exit 2, status 500 unless said otherwise). */
export function attempt<T>(fn: () => T, status: Problem["status"] = 500): Result<T> {
  try {
    return ok(fn());
  } catch (error) {
    return wrong(error instanceof Error ? error.message : String(error), status);
  }
}

/** The value of a result, or `fallback` when it is a problem. */
export function valueOr<T>(result: Result<T>, fallback: T): T {
  return result.ok ? result.value : fallback;
}
