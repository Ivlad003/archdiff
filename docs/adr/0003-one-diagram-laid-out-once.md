# One diagram, laid out once in TypeScript, for every target

A view gives one `Diagram` that archdiff places itself (ranks by depth, order by barycentre, lanes, orthogonal routes that never cross a shape), and every target — the page's Excalidraw canvas, the `.excalidraw`, draw.io and ArchiMate files, the Mermaid in the Markdown — draws those places and routes. The same code gives the same file byte for byte, and a picture looks the same in every tool. The Excalidraw arrows are not bound to their shapes: Excalidraw would pull every end to the middle of a side and the ports would collapse, so a moved shape keeps its old lines until the drawing is refreshed from the code.

## Considered options

- A layout engine per target (elk or dagre for the page, the tools' own auto-layout for the files): richer layouts and native editing, but pictures that differ between tools and between runs, and no byte-stable export for a pull request.
- Bound Excalidraw arrows: lines that follow a dragged shape, at the cost of the ports and routes the layout computed.
