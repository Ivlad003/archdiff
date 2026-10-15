// Source positions shared by the whole Markdown pipeline (Text IR, SpecIR,
// resolve, rules) and by the editor surfaces (LSP, MCP). Every node, name, link
// and reference carries a Span so that diagnostics and the LSP (hover,
// definition) can point at it. Entry points: the `Pos`/`Span`/`Spanned` types,
// `spanContains` for cursor hit-testing and `compareText` for stable sorting.

/**
 * A position in a source file. `offset` is an index into the file text
 * (UTF-16 code units, i.e. a JS string index — what LSP expects); `line` and
 * `col` are 1-based, `col` counts Unicode code points.
 */
export interface Pos {
  offset: number;
  line: number;
  col: number;
}

/** Half-open range `[start, end)`. */
export interface Span {
  start: Pos;
  end: Pos;
}

/** A value together with the place it was written. */
export interface Spanned<T> {
  value: T;
  span: Span;
}

/** The span covers `offset` (half-open: the end offset itself is outside). */
export function spanContains(span: Span, offset: number): boolean {
  return span.start.offset <= offset && offset < span.end.offset;
}

/** Code-unit order of two strings, for stable sorting of ids and paths. */
export function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
