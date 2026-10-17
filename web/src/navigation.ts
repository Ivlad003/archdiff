// Where a shape leads: the view a shape opens on a second tap (`ownView`),
// the other pictures of the same subject (`siblingViews`), and the path
// above a view for the breadcrumbs (`crumbsOf`). Pure functions of view
// keys and the views list.

import type { DiagramNode, ViewEntry } from "./api.ts";
/** The view a shape opens: a layer its modules, a module its imports, a function its calls. */
export function ownView(node: DiagramNode): string | null {
  const id = node.ref?.id ?? node.id;

  switch (node.kind) {
    case "layer":
      return `layer:${id}`;
    case "module":
    case "participant":
      return `inside:${id}`;
    case "fn":
      return `calls:${id}`;
    case "more":
      return node.ref?.id ?? null;
    case "state":
      return node.ref?.id?.startsWith("machine:") ? node.ref.id : null;
    case "action":
      // A function of the logic list, or a step that calls one function: its flowchart.
      return node.ref?.id?.includes("#") ? `logic:${node.ref.id}` : null;
    default:
      return null;
  }
}

/** The chat tag of a shape (`@module:…`, `@fn:…`), with the label the chip shows; null for a shape the agent cannot be asked about by name. */
export function tagOf(node: DiagramNode): { tag: string; label: string } | null {
  const id = node.ref?.id ?? node.id;
  const label = node.label.split("\n")[0] ?? id;

  switch (node.kind) {
    case "module":
    case "participant":
      return { tag: `@module:${id}`, label };
    case "fn":
    case "class":
      return { tag: `@fn:${id}`, label };
    case "layer":
      return { tag: `@layer:${id}`, label };
    case "action":
      return id.includes("#") ? { tag: `@logic:${id}`, label } : null;
    case "more":
      return node.ref?.id?.startsWith("dir:") ? { tag: `@dir:${node.ref.id.slice(4)}`, label } : null;
    case "state":
      return node.ref?.id?.startsWith("machine:") ? { tag: `@view:${node.ref.id}`, label } : null;
    default:
      return null;
  }
}

/** The view key of a shape's subject (`module:…`, `calls:…`), for the pictures of the same subject; null for a shape without one. */
export function subjectOf(node: DiagramNode): string | null {
  const id = node.ref?.id ?? node.id;

  switch (node.kind) {
    case "module":
    case "participant":
      return `module:${id}`;
    case "fn":
      return `calls:${id}`;
    case "class":
      return `classes:${id.slice(0, id.indexOf("#"))}`;
    case "action":
      return id.includes("#") ? `calls:${id}` : null;
    case "layer":
      return `layer:${id}`;
    case "more":
      return node.ref?.id ?? null;
    default:
      return null;
  }
}

/** The other pictures of the same subject: a module's dependencies or its inside, a function's call tree or its sequence. */
export function siblingViews(view: string): { label: string; key: string }[] {
  const at = view.indexOf(":");

  // A plain view (layers, modules, matrix…) has no subject and so no siblings.
  if (at === -1) return [];
  const kind = view.slice(0, at);
  const rest = view.slice(at + 1);

  const fnLike = rest.includes("#");

  if (fnLike && (kind === "calls" || kind === "sequence" || kind === "path" || kind === "cycle" || kind === "focus" || kind === "logic")) return [{ label: "call tree", key: `calls:${rest}` }, { label: "sequence of calls", key: `sequence:${rest}` }, { label: "path to the storages", key: `path:${rest}` }, { label: "focus: everything joined to it", key: `focus:${rest}` }, { label: "logic: the flowchart and its rules", key: `logic:${rest}` }, { label: "its call cycle", key: `cycle:${rest}` }];

  if (kind === "module" || kind === "inside" || kind === "contract" || kind === "cycle" || kind === "focus" || (kind === "classes" && rest !== "" && !rest.endsWith("/") && /\.[a-z]+$/.test(rest))) return [{ label: "dependencies", key: `module:${rest}` }, { label: "inside: functions and calls", key: `inside:${rest}` }, { label: "focus: everything joined to it", key: `focus:${rest}` }, { label: "classes: fields and methods", key: `classes:${rest}` }, { label: "contract: exports and their users", key: `contract:${rest}` }, { label: "its import cycle", key: `cycle:${rest}` }];

  if (kind === "dir" || kind === "classes") return [{ label: "modules of the directory", key: `dir:${rest}` }, { label: "classes of the directory", key: `classes:${rest}` }];

  return [];
}

/** The path above a view, for the breadcrumbs: layers › layer › directories › module › function. */
export function crumbsOf(views: readonly ViewEntry[], view: string): { label: string; key: string }[] {
  const crumbs: { label: string; key: string }[] = [{ label: "layers", key: "layers" }];
  const at = view.indexOf(":");
  const kind = at === -1 ? view : view.slice(0, at);
  const rest = at === -1 ? "" : view.slice(at + 1);
  const layerOf = (module: string): string | null => views.find((entry) => entry.key === `module:${module}`)?.layer ?? null;

  const directories = (module: string): void => {
    const parts = module.split("/");

    for (let depth = 1; depth < parts.length; depth++) {
      const key = `dir:${parts.slice(0, depth).join("/")}`;

      if (views.some((entry) => entry.key === key)) crumbs.push({ label: `${parts[depth - 1]}/`, key });
    }
  };

  if (kind === "layer") crumbs.push({ label: rest, key: view });
  else if (kind === "dir") {
    const parts = rest.split("/");

    for (let depth = 1; depth <= parts.length; depth++) crumbs.push({ label: `${parts[depth - 1]}/`, key: `dir:${parts.slice(0, depth).join("/")}` });
  } else if (kind === "classes" && rest !== "") {
    const module = rest;
    const layer = layerOf(module);

    if (layer) crumbs.push({ label: layer, key: `layer:${layer}` });
    directories(module);
    crumbs.push({ label: module.slice(module.lastIndexOf("/") + 1), key: /\.[a-z]+$/.test(module) ? `module:${module}` : `dir:${module}` });
    crumbs.push({ label: "classes", key: view });
  } else if (["module", "inside", "contract", "cycle", "calls", "sequence", "path", "type", "focus", "logic"].includes(kind)) {
    const hash = rest.indexOf("#");
    const module = hash === -1 ? rest : rest.slice(0, hash);
    const layer = layerOf(module);
    const ofFn = hash !== -1 && (kind === "focus" || kind === "logic");

    if (layer) crumbs.push({ label: layer, key: `layer:${layer}` });
    directories(module);
    crumbs.push({ label: module.slice(module.lastIndexOf("/") + 1), key: `module:${module}` });

    if (kind === "inside" || kind === "contract" || kind === "cycle" || (kind === "focus" && hash === -1)) crumbs.push({ label: kind, key: view });

    if (kind === "calls" || kind === "sequence" || kind === "path" || ofFn) crumbs.push({ label: rest.slice(hash + 1), key: `calls:${rest}` });

    if (kind === "sequence" || kind === "path" || ofFn) crumbs.push({ label: kind, key: view });

    if (kind === "type") crumbs.push({ label: `type ${rest.slice(hash + 1)}`, key: view });
  } else if (kind !== "layers") crumbs.push({ label: kind, key: view });

  return crumbs;
}
