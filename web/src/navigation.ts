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
    default:
      return null;
  }
}

/** The other pictures of the same subject: a module's dependencies or its inside, a function's call tree or its sequence. */
export function siblingViews(view: string): { label: string; key: string }[] {
  const at = view.indexOf(":");
  const kind = view.slice(0, at);
  const rest = view.slice(at + 1);

  if (kind === "module" || kind === "inside" || kind === "contract" || kind === "cycle" || (kind === "classes" && rest !== "" && !rest.endsWith("/") && /\.[a-z]+$/.test(rest))) return [{ label: "dependencies", key: `module:${rest}` }, { label: "inside: functions and calls", key: `inside:${rest}` }, { label: "classes: fields and methods", key: `classes:${rest}` }, { label: "contract: exports and their users", key: `contract:${rest}` }, { label: "its import cycle", key: `cycle:${rest}` }];

  if (kind === "dir" || kind === "classes") return [{ label: "modules of the directory", key: `dir:${rest}` }, { label: "classes of the directory", key: `classes:${rest}` }];

  if (kind === "calls" || kind === "sequence" || kind === "path") return [{ label: "call tree", key: `calls:${rest}` }, { label: "sequence of calls", key: `sequence:${rest}` }, { label: "path to the storages", key: `path:${rest}` }];

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
  } else if (["module", "inside", "contract", "cycle", "calls", "sequence", "path", "type"].includes(kind)) {
    const hash = rest.indexOf("#");
    const module = hash === -1 ? rest : rest.slice(0, hash);
    const layer = layerOf(module);

    if (layer) crumbs.push({ label: layer, key: `layer:${layer}` });
    directories(module);
    crumbs.push({ label: module.slice(module.lastIndexOf("/") + 1), key: `module:${module}` });

    if (kind === "inside" || kind === "contract" || kind === "cycle") crumbs.push({ label: kind, key: view });

    if (kind === "calls" || kind === "sequence" || kind === "path") crumbs.push({ label: rest.slice(hash + 1), key: `calls:${rest}` });

    if (kind === "sequence" || kind === "path") crumbs.push({ label: kind, key: view });

    if (kind === "type") crumbs.push({ label: `type ${rest.slice(hash + 1)}`, key: view });
  } else if (kind !== "layers") crumbs.push({ label: kind, key: view });

  return crumbs;
}
