// The module hooks of a run (`archdiff run`): loaded on Node's hooks
// thread by run-register.ts with the plan as `data`. `resolve` maps a
// project file's imports the way archdiff resolved them (tsconfig paths,
// extensionless specifiers) and sends the storage packages to mocks;
// `load` gives a mock its module (a recorder with the mock's content),
// and a project file its source with a trace call at the start of every
// function body, types stripped. Nothing else is touched: a package not
// in the plan loads as itself.
//
// Entry points: the hook exports `initialize`, `resolve`, `load`.

import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

/** What the parent computed for the run: see run.ts `RunPlan`. */
interface Plan {
  root: string;
  /** Project file (absolute path) → specifier → absolute path of the file it names, or "mock:<name>" for a storage package. */
  resolutions: Record<string, Record<string, string>>;
  /** Project file (absolute path) → the trace points of its functions: the offsets of each body and whether it is an expression. */
  bodies: Record<string, { id: string; start: number; end: number; expression: boolean }[]>;
  /** Mock name (the package specifier) → its content and the names the project imports from it. */
  mocks: Record<string, { content: unknown; names: string[] }>;
}

let plan: Plan = { root: "", resolutions: {}, bodies: {}, mocks: {} };

/** archdiff's own modules (the harness, the recorder) load the real packages: only the repository's code sees the mocks. */
const ownDirectory = fileURLToPath(new URL("./", import.meta.url));

export function initialize(data: Plan): void {
  plan = data;
}

interface ResolveContext {
  parentURL?: string;
}

type ResolveResult = { url: string; format?: string; shortCircuit?: boolean };

export async function resolve(specifier: string, context: ResolveContext, next: (specifier: string, context: ResolveContext) => Promise<ResolveResult>): Promise<ResolveResult> {
  if (specifier.startsWith("archdiff-mock:")) return { url: specifier, shortCircuit: true };
  const parent = context.parentURL && context.parentURL.startsWith("file:") ? fileURLToPath(context.parentURL) : null;
  const mapped = parent ? plan.resolutions[parent]?.[specifier] : undefined;

  if (mapped !== undefined) return mapped.startsWith("mock:") ? { url: `archdiff-mock:${mapped.slice(5)}`, shortCircuit: true } : { url: pathToFileURL(mapped).href, shortCircuit: true };

  // A storage package imported from a file the plan does not know (a dependency's own import): still the mock, inside the repository.
  if (plan.mocks[specifier] && parent && parent.startsWith(plan.root) && !parent.startsWith(ownDirectory)) return { url: `archdiff-mock:${specifier}`, shortCircuit: true };

  return next(specifier, context);
}

interface LoadContext {
  format?: string | null;
}

type LoadResult = { format: string; source?: string | ArrayBuffer | Uint8Array; shortCircuit?: boolean };

/** The source of a mock module: a recorder whose every member call is reported, answered from the content by the member's name. */
function mockSource(name: string, mock: { content: unknown; names: string[] }): string {
  const exports = mock.names.filter((item) => item !== "default" && /^[A-Za-z_$][\w$]*$/.test(item));

  return `const content = ${JSON.stringify(mock.content ?? null)};
const name = ${JSON.stringify(name)};
const record = (member, args) => globalThis.__archdiff?.storage(name, member, args);
const answer = (member) => (content && typeof content === "object" && member in content ? content[member] : content && typeof content === "object" && "rows" in content && /^(query|find|findMany|select|all|get|read|readFile|readFileSync|execute|exec)/.test(member) ? content : undefined);
const value = (member) => new Proxy(function () {}, {
  apply: (_target, _this, args) => {
    record(member, args);
    const out = answer(member);
    return out instanceof Promise ? out : /^(query|find|findMany|findOne|execute|exec|connect|get|set|del|put|send|read|write|readFile|writeFile|appendFile|mkdir|readdir|rm|unlink|stat|open)$/.test(member) || /Async$/.test(member) ? Promise.resolve(out) : out;
  },
  construct: (_target, args) => {
    record(\`new \${member}\`, args);
    return new Proxy({}, { get: (_t, inner) => (typeof inner === "string" ? value(\`\${member}.\${inner}\`) : undefined) });
  },
  get: (_target, inner) => (typeof inner === "string" && inner !== "then" ? value(\`\${member}.\${inner}\`) : undefined),
});
const mod = new Proxy({}, { get: (_target, member) => (typeof member === "string" && member !== "then" && member !== "__esModule" ? value(member) : undefined) });
export default mod;
${exports.map((item) => `export const ${item} = value(${JSON.stringify(item)});`).join("\n")}
`;
}

/** The source with a trace call at the start of every function body (`=> expr` becomes `=> (trace, expr)`), edited from the end backwards so the offsets stay true. */
function instrument(source: string, bodies: { id: string; start: number; end: number; expression: boolean }[]): string {
  const edits: { at: number; text: string }[] = [];

  for (const body of bodies) {
    const call = `globalThis.__archdiff?.enter(${JSON.stringify(body.id)})`;

    if (body.expression) {
      edits.push({ at: body.start, text: `(${call}, ` }, { at: body.end, text: ")" });
    } else edits.push({ at: body.start, text: `${call};` });
  }

  let out = source;

  for (const edit of edits.sort((a, b) => b.at - a.at)) out = `${out.slice(0, edit.at)}${edit.text}${out.slice(edit.at)}`;

  return out;
}

export async function load(url: string, context: LoadContext, next: (url: string, context: LoadContext) => Promise<LoadResult>): Promise<LoadResult> {
  if (url.startsWith("archdiff-mock:")) {
    const name = url.slice("archdiff-mock:".length);

    return { format: "module", source: mockSource(name, plan.mocks[name] ?? { content: null, names: [] }), shortCircuit: true };
  }

  if (!url.startsWith("file:")) return next(url, context);
  const path = fileURLToPath(url);
  const bodies = plan.bodies[path];

  if (!bodies) return next(url, context);
  const source = readFileSync(path, "utf8");
  const traced = instrument(source, bodies);
  // A TypeScript file runs with its types stripped (enums and parameter properties transformed); JavaScript as it is.
  const javascript = /\.[cm]?tsx?$/.test(path) ? stripTypeScriptTypes(traced, { mode: "transform", sourceUrl: url }) : traced;

  return { format: path.endsWith(".cjs") ? "commonjs" : "module", source: javascript, shortCircuit: true };
}
