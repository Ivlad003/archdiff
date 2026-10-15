// One entry for every text format a placed Diagram can become: Mermaid,
// draw.io, Excalidraw, ArchiMate Open Exchange, or the Diagram JSON itself.

import type { Diagram } from "../diagram.ts";
import { toArchimate } from "./archimate.ts";
import { toDrawio } from "./drawio.ts";
import { toExcalidraw } from "./excalidraw.ts";
import { toMermaid } from "./mermaid.ts";

export const EXPORT_FORMATS = ["md", "mermaid", "json", "drawio", "excalidraw", "archimate"] as const;

export type ExportFormat = (typeof EXPORT_FORMATS)[number];

/** The file extension of a format, for downloads and `--out`. */
export const EXPORT_EXTENSION: Record<ExportFormat, string> = { md: ".md", mermaid: ".mmd", json: ".json", drawio: ".drawio", excalidraw: ".excalidraw", archimate: ".xml" };

export const EXPORT_MEDIA_TYPE: Record<ExportFormat, string> = { md: "text/markdown; charset=utf-8", mermaid: "text/plain; charset=utf-8", json: "application/json", drawio: "application/xml", excalidraw: "application/json", archimate: "application/xml" };

/** The text of a placed diagram in `format`; `md` is the Markdown page (markdown.ts), which needs the analysis, so it is not here. */
export function exportDiagram(diagram: Diagram, format: Exclude<ExportFormat, "md">): string {
  switch (format) {
    case "mermaid":
      return toMermaid(diagram);
    case "json":
      return `${JSON.stringify({ generator: "archdiff", ...diagram }, null, 2)}\n`;
    case "drawio":
      return toDrawio(diagram);
    case "excalidraw":
      return toExcalidraw(diagram);
    case "archimate":
      return toArchimate(diagram);
  }
}
