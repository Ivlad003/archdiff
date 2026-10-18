// Where a shape leads: the view a shape opens on a second tap (`ownView`),
// the other pictures of the same subject (`siblingViews`), and the path
// above a view for the breadcrumbs (`crumbsOf`). Pure functions of view
// keys and the views list.

import type { Shape, ViewEntry } from "./api.ts";
import { parseView } from "../../src/view-keys.ts";

/** The view a shape opens: a layer its modules, a module its imports, a function its calls. */
export function ownView(node: Shape): string | null {
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
export function tagOf(node: Shape): { tag: string; label: string } | null {
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
export function subjectOf(node: Shape): string | null {
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
export function siblingViews(key: string): { label: string; key: string }[] {
  const view = parseView(key);

  // A plain view (layers, modules, matrix…) has no subject and so no siblings.
  if (!view || view.subject === null) return [];
  const subject = view.subject;
  const of = (kind: string, label: string): { label: string; key: string } => ({ label, key: `${kind}:${subject}` });

  // A function's pictures: its calls, their order, its way to the storages, everything joined to it, its logic, its cycle.
  if (subject.includes("#") && ["calls", "sequence", "path", "cycle", "focus", "logic"].includes(view.kind)) return [of("calls", "call tree"), of("sequence", "sequence of calls"), of("path", "path to the storages"), of("focus", "focus: everything joined to it"), of("logic", "logic: the flowchart and its rules"), of("cycle", "its call cycle")];

  // A module's pictures (a classes view of one file is one of them).
  if (["module", "inside", "usage", "cycle", "focus"].includes(view.kind) || (view.kind === "classes" && /\.[a-z]+$/.test(subject))) return [of("module", "dependencies"), of("inside", "inside: functions and calls"), of("focus", "focus: everything joined to it"), of("classes", "classes: fields and methods"), of("usage", "usage: who uses its exports"), of("cycle", "its import cycle")];

  if (view.kind === "dir" || view.kind === "classes") return [of("dir", "modules of the directory"), of("classes", "classes of the directory")];

  return [];
}

/** The path above a view, for the breadcrumbs: layers › layer › directories › module › function. */
export function crumbsOf(views: readonly ViewEntry[], key: string): { label: string; key: string }[] {
  const crumbs: { label: string; key: string }[] = [{ label: "layers", key: "layers" }];
  const view = parseView(key);
  const layerOf = (module: string): string | null => views.find((entry) => entry.key === `module:${module}`)?.layer ?? null;

  // The directories above a module that have views of their own.
  const directories = (module: string): void => {
    const parts = module.split("/");

    for (let depth = 1; depth < parts.length; depth++) {
      const dir = `dir:${parts.slice(0, depth).join("/")}`;

      if (views.some((entry) => entry.key === dir)) crumbs.push({ label: `${parts[depth - 1]}/`, key: dir });
    }
  };

  if (!view || view.kind === "layers") return crumbs;

  if (view.subject === null) {
    crumbs.push({ label: view.kind, key });

    return crumbs;
  }

  const subject = view.subject;

  if (view.kind === "layer") crumbs.push({ label: subject, key });
  else if (view.kind === "dir") {
    const parts = subject.split("/");

    for (let depth = 1; depth <= parts.length; depth++) crumbs.push({ label: `${parts[depth - 1]}/`, key: `dir:${parts.slice(0, depth).join("/")}` });
  } else if (view.kind === "classes") {
    const layer = layerOf(subject);

    if (layer) crumbs.push({ label: layer, key: `layer:${layer}` });
    directories(subject);
    crumbs.push({ label: subject.slice(subject.lastIndexOf("/") + 1), key: /\.[a-z]+$/.test(subject) ? `module:${subject}` : `dir:${subject}` });
    crumbs.push({ label: "classes", key });
  } else if (["module", "inside", "usage", "cycle", "calls", "sequence", "path", "type", "focus", "logic"].includes(view.kind)) {
    // The layer, the directories and the module above the subject; then the function, then the picture of it.
    const hash = subject.indexOf("#");
    const module = hash === -1 ? subject : subject.slice(0, hash);
    const layer = layerOf(module);
    const ofFn = hash !== -1 && (view.kind === "focus" || view.kind === "logic" || view.kind === "cycle");

    if (layer) crumbs.push({ label: layer, key: `layer:${layer}` });
    directories(module);
    crumbs.push({ label: module.slice(module.lastIndexOf("/") + 1), key: `module:${module}` });

    if (hash === -1 && (view.kind === "inside" || view.kind === "usage" || view.kind === "cycle" || view.kind === "focus")) crumbs.push({ label: view.kind, key });

    if (view.kind === "calls" || view.kind === "sequence" || view.kind === "path" || ofFn) crumbs.push({ label: subject.slice(hash + 1), key: `calls:${subject}` });

    if (view.kind === "sequence" || view.kind === "path" || ofFn) crumbs.push({ label: view.kind, key });

    if (view.kind === "type") crumbs.push({ label: `type ${subject.slice(hash + 1)}`, key });
  } else crumbs.push({ label: view.kind, key });

  return crumbs;
}
