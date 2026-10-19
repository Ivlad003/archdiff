// What a shape of a picture stands for and where it leads, said once for
// the exports and the page: the code a shape stands for (`standsFor`),
// the view a second tap on it opens (`opensView`), the view whose
// pictures are its siblings (`subjectView`), its chat tag (`tagOf`), the
// tags of the chat read back from a text (`tagsIn`, `tagView`), the shape
// of a commit (`commitShapeId`, `commitOfShape`), and the element ID of a
// line on the canvas (`lineElementId`). The Excalidraw export writes
// `opensView` into every shape (`customData.view`) and the page calls the
// same function, so a double tap, Enter and the menu open the same view.
// Node-free, importing only the table of kinds: bundled into the page
// beside options.ts and view-keys.ts.
//
// Entry points: `standsFor`, `moduleOfShape`, `opensView`, `subjectView`,
// `tagOf`, `tagsIn`, `tagView`, `TAG_PREFIXES`, `commitShapeId`,
// `commitOfShape`, `lineElementId`.

import type { Line, Shape } from "./diagram.ts";
import { VIEW_KINDS, tagOf as kindTagOf, type ViewKind } from "./view-keys.ts";

/** The module part of a declaration's ID (`src/x.ts#f` → `src/x.ts`), or the ID itself. */
function moduleOfId(id: string): string {
  const at = id.indexOf("#");

  return at === -1 ? id : id.slice(0, at);
}

/** The declaration or module a shape stands for: its code's ID, else its own (a layer's name, a package's, a cell's). */
export function standsFor(shape: Shape): string {
  return shape.ref?.id ?? shape.id;
}

/** The module a shape stands for, when it stands for a module or a declaration of one; null for a layer, a package, a cell. */
export function moduleOfShape(shape: Shape): string | null {
  if (shape.kind === "module" || shape.kind === "participant") return standsFor(shape);

  if (shape.kind === "fn" || shape.kind === "class") return moduleOfId(standsFor(shape));

  return null;
}

/**
 * The view a second tap on a shape opens: the one the shape names (a
 * folded tail, a package, a machine, a header of a matrix), else what its
 * kind and code imply — a layer its modules, a module its inside, a
 * function its calls, a class box its module's inside, a step of a
 * function's logic the logic of the function it calls; null for a shape
 * that opens nothing.
 */
export function opensView(shape: Shape): string | null {
  if (shape.opens !== undefined) return shape.opens;
  const id = standsFor(shape);

  switch (shape.kind) {
    case "layer":
      return `layer:${id}`;
    case "module":
    case "participant":
      return `inside:${id}`;
    case "fn":
      return `calls:${id}`;
    case "class":
      return `inside:${moduleOfId(id)}`;
    case "action":
      return shape.ref?.id?.includes("#") ? `logic:${shape.ref.id}` : null;
    default:
      return null;
  }
}

/** The view whose subject the shape is — a module's dependencies, a function's call tree, a layer — where its other pictures start; null for a shape without one. */
export function subjectView(shape: Shape): string | null {
  const id = standsFor(shape);

  switch (shape.kind) {
    case "module":
    case "participant":
      return `module:${id}`;
    case "fn":
      return `calls:${id}`;
    case "class":
      return `classes:${moduleOfId(id)}`;
    case "action":
      return shape.ref?.id?.includes("#") ? `calls:${shape.ref.id}` : null;
    case "layer":
      return `layer:${id}`;
    default:
      return shape.opens ?? null;
  }
}

/** The chat tag of a shape (`@module:…`, `@fn:…`, `@logic:…`, `@view:…`) with the label its chip shows; null for a shape the agent cannot be asked about by name. */
export function tagOf(shape: Shape): { tag: string; label: string } | null {
  const id = standsFor(shape);
  const label = shape.label.split("\n")[0] ?? id;

  switch (shape.kind) {
    case "module":
    case "participant":
      return { tag: `@module:${id}`, label };
    case "fn":
    case "class":
      return { tag: `@fn:${id}`, label };
    case "layer":
      return { tag: `@layer:${id}`, label };
    case "action":
      return shape.ref?.id?.includes("#") ? { tag: `@logic:${shape.ref.id}`, label } : null;
    default:
      // A shape that names its view (a folded directory, a package, a machine) is asked about as that picture.
      return shape.opens !== undefined ? { tag: `@view:${shape.opens}`, label } : null;
  }
}

/** The prefixes of the chat's tags: the subject tags of the table of kinds (`layer`, `dir`, `module`, `flow`, `type`, `logic`), `fn` for a function, `view` for a picture with its options. */
export const TAG_PREFIXES: readonly string[] = [...new Set([...(Object.keys(VIEW_KINDS) as ViewKind[]).flatMap((kind) => kindTagOf(kind)?.prefix ?? []), "fn", "view"])];

/** The tags written in a text (`@module:src/x.ts`, `@fn:src/x.ts#f`), each once, in order; the sentence's punctuation after a tag (`(@module:x).`) is not the subject's. */
export function tagsIn(text: string): { tag: string; prefix: string; subject: string }[] {
  const out: { tag: string; prefix: string; subject: string }[] = [];
  const seen = new Set<string>();

  for (const match of text.matchAll(new RegExp(`@(${TAG_PREFIXES.join("|")}):(\\S+)`, "g"))) {
    const prefix = match[1]!;
    const subject = match[2]!.replace(/[.,;:)]+$/, "");
    const tag = `@${prefix}:${subject}`;

    if (seen.has(tag)) continue;
    seen.add(tag);
    out.push({ tag, prefix, subject });
  }

  return out;
}

/**
 * The view a tag's context is drawn from: a function's call tree (`@fn:`), the picture `@view:` names, a kind's own
 * view of the subject (`@module:`, `@logic:`, …); null for `@flow:`, whose context is the data flow of the entry, no picture.
 */
export function tagView(prefix: string, subject: string): string | null {
  if (prefix === "fn") return `calls:${subject}`;

  if (prefix === "view") return subject;

  if (prefix === "flow") return null;
  const kind = (Object.keys(VIEW_KINDS) as ViewKind[]).find((candidate) => kindTagOf(candidate)?.prefix === prefix);

  return kind === undefined ? null : `${kind}:${subject}`;
}

/** The shape of a commit (in the branches, the timeline): `commit:<sha>`, which the shape opens as its own page. */
export function commitShapeId(sha: string): string {
  return `commit:${sha}`;
}

/** The sha a commit's shape ID (or the view it opens) names; null for any other. */
export function commitOfShape(id: string | undefined): string | null {
  return id !== undefined && id.startsWith("commit:") ? id.slice("commit:".length) : null;
}

/**
 * The element ID of the line at `index` of a picture's lines: by its two ends, and by its index too when one pair
 * of shapes has several — a sequence's messages always, two cases of a switch that end in one place, two
 * transitions between two states — so every ID of a scene is its own.
 */
export function lineElementId(lines: readonly Line[], index: number): string {
  const line = lines[index]!;
  const again = line.kind === "message" || lines.slice(0, index).some((other) => other.from === line.from && other.to === line.to);

  return `edge:${line.from}->${line.to}${again ? `:${index}` : ""}`;
}
