// Entry points frameworks and packages declare outside the call graph: the
// files a package.json names (`main`, `bin`, `exports`), React Router
// route modules (file-based routes under a `routes/` directory, whose
// `loader`, `action`, `clientLoader`, `clientAction`, `default` and
// `ErrorBoundary` exports the framework calls), and SFCC cartridge hooks
// (`cartridges/<name>/hooks.json` names a script whose exports the
// platform calls at the named extension point). Reading hooks.json is the
// only I/O; the rest is a pure match over the file list.
//
// Sits beside the config at the start of the pipeline: root + files →
// DeclaredEntry[], which views.ts turns into `calls:` views.
// Entry points: `frameworkEntries`, `DeclaredEntry`.

import { readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { isJsonObject, isJsonString, parseJson } from "./json.ts";

/** A function a framework calls: its module, its export name and how the framework names it. */
export interface DeclaredEntry {
  module: string;
  /** The export name (`default`, `loader`), or `*` for every exported function of the module. */
  exportName: string;
  /** `route cart.tsx: loader`, `hook dw.ocapi.shop.category.modifyGETResponse`. */
  label: string;
}

const ROUTE_EXPORTS = ["default", "loader", "action", "clientLoader", "clientAction", "ErrorBoundary"];

/** `src/routes/cart.tsx`, `src/extensions/bopis/routes/x.tsx`: a route module, unless a test or a story. */
function isRouteModule(path: string): boolean {
  const segments = path.split("/");

  return segments.includes("routes") && segments[segments.length - 1] !== "routes.ts" && !/\.(test|spec|stories)\.[cm]?[jt]sx?$/.test(path);
}

/** The entries SFCC cartridges declare: each `hooks.json` names scripts by a path relative to the cartridge. */
function cartridgeHooks(root: string, files: ReadonlySet<string>, manifests: readonly string[]): DeclaredEntry[] {
  const entries: DeclaredEntry[] = [];

  for (const manifest of manifests) {
    let parsed;

    try {
      parsed = parseJson(readFileSync(join(root, manifest), "utf8"));
    } catch {
      continue;
    }

    if (!isJsonObject(parsed) || !Array.isArray(parsed["hooks"])) continue;
    const directory = posix.dirname(manifest);

    for (const hook of parsed["hooks"]) {
      if (!isJsonObject(hook) || !isJsonString(hook["name"]) || !isJsonString(hook["script"])) continue;
      const base = posix.normalize(posix.join(directory, hook["script"]));
      const script = [base, `${base}.js`, `${base}.ts`, `${base}/index.js`, `${base}/index.ts`].find((candidate) => files.has(candidate));

      if (script) entries.push({ module: script, exportName: "*", label: `hook ${hook["name"]}` });
    }
  }

  return entries;
}

/** The files a package.json names as the package's entry (`main`, `module`, `bin`, the `.` export): what users of the library call. */
function packageEntries(root: string, files: ReadonlySet<string>, manifests: readonly string[]): DeclaredEntry[] {
  const entries: DeclaredEntry[] = [];

  const probe = (directory: string, written: string): string | null => {
    const base = posix.normalize(posix.join(directory, written.replace(/^\.\//, "")));
    const candidates = [base, `${base}.js`, `${base}.ts`, `${base}.mjs`, `${base}.cjs`, posix.join(base, "index.js"), posix.join(base, "index.ts")];

    return candidates.find((candidate) => files.has(candidate)) ?? null;
  };

  for (const manifest of manifests) {
    let parsed;

    try {
      parsed = parseJson(readFileSync(join(root, manifest), "utf8"));
    } catch {
      continue;
    }

    if (!isJsonObject(parsed)) continue;
    const directory = posix.dirname(manifest) === "." ? "" : posix.dirname(manifest);
    const name = isJsonString(parsed["name"]) ? parsed["name"] : manifest;
    const named: [string, string][] = [];

    for (const field of ["main", "module"]) if (isJsonString(parsed[field])) named.push([parsed[field] as string, `${field} of ${name}`]);
    const bin = parsed["bin"];

    if (isJsonString(bin)) named.push([bin, `bin of ${name}`]);
    else if (isJsonObject(bin)) for (const [command, file] of Object.entries(bin)) if (isJsonString(file)) named.push([file, `bin ${command}`]);
    const exportsField = parsed["exports"];
    const dot = isJsonString(exportsField) ? exportsField : isJsonObject(exportsField) ? exportsField["."] : undefined;
    const dotFile = isJsonString(dot) ? dot : isJsonObject(dot) ? [dot["import"], dot["default"], dot["require"]].find(isJsonString) : undefined;

    if (dotFile) named.push([dotFile, `export of ${name}`]);

    // Without any of them npm loads index.js, as the package's own entry.
    if (named.length === 0) named.push(["index.js", `index of ${name}`]);

    for (const [written, label] of named) {
      const file = probe(directory, written);

      if (file && !entries.some((entry) => entry.module === file)) entries.push({ module: file, exportName: "*", label });
    }
  }

  return entries;
}

/** Every entry the frameworks of the repository declare, sorted by module and label. `allFiles` is every path git lists (hooks.json is not a source file). */
export function frameworkEntries(root: string, sourceFiles: readonly string[], allFiles: readonly string[]): DeclaredEntry[] {
  const sources = new Set(sourceFiles);
  const entries: DeclaredEntry[] = [];
  // The package's own entry files (not those of vendored packages).
  entries.push(...packageEntries(root, sources, allFiles.filter((path) => /(^|\/)package\.json$/.test(path) && !path.includes("node_modules/")).sort()));

  for (const path of sourceFiles) {
    if (!isRouteModule(path)) continue;
    const name = posix.basename(path);

    for (const exportName of ROUTE_EXPORTS) entries.push({ module: path, exportName, label: `route ${name}: ${exportName}` });
  }

  const manifests = allFiles.filter((path) => /(^|\/)cartridges\/[^/]+\/hooks\.json$/.test(path)).sort();
  entries.push(...cartridgeHooks(root, sources, manifests));

  return entries.sort((a, b) => (a.module < b.module ? -1 : a.module > b.module ? 1 : a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
}
