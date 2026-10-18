// Entry points frameworks and packages declare outside the call graph: the
// files a package.json names (`main`, `bin`, `exports`), React Router
// route modules (file-based routes under a `routes/` directory, whose
// `loader`, `action`, `clientLoader`, `clientAction`, `default` and
// `ErrorBoundary` exports the framework calls), SFCC cartridge hooks
// (`cartridges/<name>/hooks.json` names a script whose exports the
// platform calls at the named extension point), and the listeners a
// browser extension registers (`chrome.runtime.onConnect.addListener(f)`,
// a port's `onMessage`), labelled with the role its manifest.json gives
// the script. Reading hooks.json, manifest.json and the pages it names is
// the only I/O; the rest is a pure match over the file list and the facts.
//
// Sits beside the config at the start of the pipeline: root + files →
// DeclaredEntry[], which views.ts turns into `calls:` views.
// Entry points: `frameworkEntries`, `extensionEntries`, `DeclaredEntry`.

import { readFileSync } from "node:fs";
import { join, posix } from "node:path";
import type { CallFact, DeclFact, FileFacts } from "./extract/facts.ts";
import { isJsonObject, isJsonString, parseJson, type JsonValue } from "./json.ts";

/** A function a framework calls: its module, its export name and how the framework names it. */
export interface DeclaredEntry {
  module: string;
  /** The export name (`default`, `loader`), or `*` for every exported function of the module; with `local`, a declaration's name, exported or not. */
  exportName: string;
  /** `exportName` names a declaration of the module rather than an export: a listener need not be exported. */
  local?: true;
  /** `route cart.tsx: loader`, `hook dw.ocapi.shop.category.modifyGETResponse`, `listener chrome.runtime.onConnect of the background`. */
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

/** A package of the repository (a package.json outside node_modules): its name, directory and the packages it declares as dependencies. */
export interface RepositoryPackage {
  name: string;
  /** The directory, "" for the root. */
  dir: string;
  dependencies: string[];
  /** The source file an import of the package by its name lands on (a workspace of a monorepo); null when none is found. */
  entry: string | null;
}

/** The extensions a written entry may leave out, in TypeScript's order of preference for a source. */
const ENTRY_EXTENSIONS = ["", ".ts", ".tsx", ".mts", ".js", ".jsx", ".mjs", ".cjs"];

/**
 * The source file a package's own name stands for, among `files`: what its package.json names (`source`, the `.`
 * export, `module`, `main`, `types`), as written or as the source it was built from (`dist/index.js` from
 * `src/index.ts`), else an index file at its top or in its `src/`.
 */
function packageEntry(directory: string, manifest: Record<string, JsonValue>, files: ReadonlySet<string>): string | null {
  const probe = (written: string): string | null => {
    const base = posix.normalize(posix.join(directory, written.replace(/^\.\//, ""))).replace(/\.(d\.ts|[cm]?js|jsx)$/, "");
    const stems = [base, posix.join(base, "index")];

    for (const stem of stems) for (const extension of ENTRY_EXTENSIONS) if (files.has(stem + extension)) return stem + extension;

    return null;
  };
  const exportsField = manifest["exports"];
  const dot = isJsonString(exportsField) ? exportsField : isJsonObject(exportsField) ? exportsField["."] : undefined;
  const written = [manifest["source"], ...(isJsonObject(dot) ? [dot["source"], dot["types"], dot["import"], dot["default"], dot["require"]] : [dot]), manifest["module"], manifest["main"], manifest["types"], manifest["typings"]].filter(isJsonString);

  for (const entry of written) {
    const found = probe(entry);

    if (found) return found;
    // A built output names the source it was built from: `dist/index.js` from `src/index.ts`.
    const built = /^(\.\/)?(dist|build|lib|out)\//.exec(entry);

    if (built) {
      const source = probe(entry.replace(/^(\.\/)?(dist|build|lib|out)\//, "src/"));

      if (source) return source;
    }
  }

  return probe("src/index") ?? probe("index");
}

/** Every package.json of the repository, read for its name and dependency names, sorted by directory. */
export function repositoryPackages(root: string, allFiles: readonly string[]): RepositoryPackage[] {
  const packages: RepositoryPackage[] = [];
  const files = new Set(allFiles);

  for (const manifest of allFiles.filter((path) => /(^|\/)package\.json$/.test(path) && !path.includes("node_modules/")).sort()) {
    let parsed;

    try {
      parsed = parseJson(readFileSync(join(root, manifest), "utf8"));
    } catch {
      continue;
    }

    if (!isJsonObject(parsed) || !isJsonString(parsed["name"])) continue;
    const dependencies: string[] = [];

    for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
      const list = parsed[field];

      if (isJsonObject(list)) dependencies.push(...Object.keys(list));
    }

    const dir = posix.dirname(manifest) === "." ? "" : posix.dirname(manifest);
    packages.push({ name: parsed["name"], dir, dependencies: [...new Set(dependencies)].sort(), entry: packageEntry(dir, parsed, files) });
  }

  return packages;
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

/** A call that registers a listener of a browser event: `chrome.runtime.onConnect.addListener(f)`, `port.onMessage.addListener(f)`, `browser.tabs.onUpdated.addListener(f)`. */
const BROWSER_LISTENER = /^([\w$.]+)\.(on[A-Z]\w*)\.addListener$/;

/**
 * The scripts a browser extension's `manifest.json` names, by the role they run in: the background script (a service
 * worker, or MV2 scripts), the content scripts, and the scripts of the pages it names — the side panel, a popup, the
 * options page, the devtools page — read from each page's `<script src>`.
 */
function extensionRoles(root: string, allFiles: readonly string[], sources: ReadonlySet<string>): Map<string, string> {
  const roles = new Map<string, string>();
  const every = new Set(allFiles);

  for (const manifest of allFiles.filter((path) => posix.basename(path) === "manifest.json")) {
    let parsed: JsonValue;

    try {
      parsed = parseJson(readFileSync(join(root, manifest), "utf8"));
    } catch {
      continue;
    }

    if (!isJsonObject(parsed) || typeof parsed["manifest_version"] !== "number") continue;
    const dir = posix.dirname(manifest);
    const at = (path: string, from: string): string => posix.normalize(posix.join(from, path));
    const script = (path: JsonValue | undefined, role: string, from = dir): void => {
      if (isJsonString(path) && sources.has(at(path, from))) roles.set(at(path, from), role);
    };
    // A page's scripts: `<script src="panel.js">`, relative to the page.
    const page = (path: JsonValue | undefined, role: string): void => {
      if (!isJsonString(path) || !every.has(at(path, dir))) return;
      let html: string;

      try {
        html = readFileSync(join(root, at(path, dir)), "utf8");
      } catch {
        return;
      }

      for (const match of html.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)) if (!/^[a-z]+:/i.test(match[1]!)) script(match[1], role, posix.dirname(at(path, dir)));
    };
    const background = parsed["background"];

    if (isJsonObject(background)) {
      script(background["service_worker"], "background");

      for (const file of Array.isArray(background["scripts"]) ? background["scripts"] : []) script(file, "background");
    }

    for (const content of Array.isArray(parsed["content_scripts"]) ? parsed["content_scripts"] : []) {
      if (!isJsonObject(content)) continue;

      for (const file of Array.isArray(content["js"]) ? content["js"] : []) script(file, "content script");
    }

    const sidePanel = parsed["side_panel"];

    if (isJsonObject(sidePanel)) page(sidePanel["default_path"], "side panel");

    for (const key of ["action", "browser_action", "page_action"]) {
      const action = parsed[key];

      if (isJsonObject(action)) page(action["default_popup"], "popup");
    }

    page(parsed["options_page"], "options");
    const optionsUi = parsed["options_ui"];

    if (isJsonObject(optionsUi)) page(optionsUi["page"], "options");
    page(parsed["devtools_page"], "devtools");
  }

  return roles;
}

/**
 * The entries a browser extension has: every function a script hands to a browser event's `addListener` — the
 * browser calls it when the event fires — labelled with the event and the role manifest.json gives the script. A
 * listener written in place (an arrow) keeps its calls at the module's top level, which the `inside:` view draws.
 */
export function extensionEntries(root: string, allFiles: readonly string[], facts: ReadonlyMap<string, FileFacts>): DeclaredEntry[] {
  const roles = extensionRoles(root, allFiles, new Set(facts.keys()));
  const entries: DeclaredEntry[] = [];
  const seen = new Set<string>();

  for (const file of facts.values()) {
    const declared = new Set(file.decls.filter((decl) => decl.kind === "fn").map((decl) => decl.name));

    const record = (call: CallFact): void => {
      const event = BROWSER_LISTENER.exec(call.callee);
      const handler = call.passes?.find((pass) => pass.form.kind === "name" && declared.has(pass.form.name));

      if (!event || !handler || handler.form.kind !== "name" || seen.has(`${file.path}#${handler.form.name}`)) return;
      seen.add(`${file.path}#${handler.form.name}`);
      const role = roles.get(file.path);
      entries.push({ module: file.path, exportName: handler.form.name, local: true, label: `listener ${event[1]}.${event[2]}${role ? ` of the ${role}` : ""}` });
    };

    const walk = (decl: DeclFact): void => {
      for (const call of decl.calls) record(call);

      for (const member of decl.members) walk(member);
    };

    for (const decl of file.decls) walk(decl);

    for (const call of file.moduleCalls) record(call);
  }

  return entries;
}
