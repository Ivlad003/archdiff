# ARCHITECTURE.md, one Mermaid flowchart, is the contract

The architecture a repository is meant to have lives in `ARCHITECTURE.md` as one Mermaid flowchart inside Markdown prose: a subgraph is a layer, a node is a module (its label the path, then what it does), an arrow is an import the contract allows between the layers of its ends. `archdiff check` fails on an import between two of its layers that no arrow allows, `review` reports a new layer dependency as a finding only when the contract forbids it, and when `archdiff.json` names no layers, the contract's subgraphs place the files. `new`, `import`, `intent --init`, the page's *code this* and *from document* all write this one file.

## Considered options

- A rules file of its own (JSON or YAML: layer → may import) beside `archdiff.json`: precise, but a second format that coding agents do not read or write as naturally as Markdown, and one that renders nowhere.
- `archdiff.json` as the place of the architecture: it already names the layers, but globs say where files are, not which way they may depend, and a JSON file is not a document a reader or an agent reviews.

The flowchart renders on GitHub, reads as a diagram, and is what agents already write; the cost is a parser for a subset of Mermaid (intent.ts) and a contract that names representative modules rather than every file (the layers' globs place the rest).
