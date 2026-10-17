# Architecture

archdiff's own contract, kept by archdiff: `archdiff check` fails when an import crosses the layers against the arrows below, `archdiff diagram intent` draws this file against the code. A subgraph is a layer, a node is a module (its path, then what it does), an arrow is an import. The modules named here are the ones that stand for their layer; `archdiff.json` places every other file in its layer by path.

The direction of the arrows is the direction of the pipeline: the entry points (bin, cli, server, page) read the products (views, exports), which read the placed picture (diagram), which reads the analysis (core), which reads the language frontends (extract). Nothing below imports anything above it except types.

```mermaid
flowchart LR
  subgraph n_bin["bin — the executable"]
    n_bin_archdiff_js["bin/archdiff.js<br>the entry: runs main and sets the exit code"]
  end
  subgraph n_cli["cli — the commands"]
    n_src_cli_ts["src/cli.ts<br>parses the arguments and calls the modules; exit codes 0, 1, 2"]
  end
  subgraph n_server["server — archdiff web: the HTTP API and the page"]
    n_src_server_ts["src/server.ts<br>the server: the context, the route tables, the static page"]
    n_src_routes_pictures_ts["src/routes/pictures.ts<br>the routes of the pictures: views, scene, a shape, a line, exports"]
    n_src_routes_agent_ts["src/routes/agent.ts<br>the routes of the agent and the contract"]
  end
  subgraph n_page["page — the browser page (web/src), built by esbuild"]
    n_web_src_app_ts["web/src/app.ts<br>the page: the canvas, the panels, the tools; reads only the types of the diagram"]
  end
  subgraph n_views["views — one picture per question, and the reports"]
    n_src_views_ts["src/views.ts<br>the structural views and viewOf: the chain of pure steps after a view"]
    n_src_views_more_ts["src/views-more.ts<br>the question views: cycles, matrix, type, path, contract, events, tests, hotspots"]
    n_src_shape_ts["src/shape.ts<br>hubs as badges, hidden lanes, the mix, the fold, the weight"]
    n_src_diff_ts["src/diff.ts<br>the architectural diff of a change: review, compare, history"]
    n_src_intent_view_ts["src/intent-view.ts<br>ARCHITECTURE.md drawn against the code"]
    n_src_flow_ts["src/flow.ts<br>the data flow of a call tree with mocks, and which modules are storages"]
    n_src_pipeline_ts["src/pipeline.ts<br>the steps after a view as data: hide, mix, hubs, fold, weight, marks, overlays"]
    n_src_metrics_ts["src/metrics.ts<br>coupling and cohesion: Ca, Ce, I, A, D, the cohesion of a module's functions"]
    n_src_cycles_ts["src/cycles.ts<br>import, call and layer cycles, and where to cut them"]
  end
  subgraph n_exports["exports — the picture as text and files"]
    n_src_export_index_ts["src/export/index.ts<br>Mermaid, draw.io, Excalidraw, ArchiMate, JSON"]
    n_src_markdown_ts["src/markdown.ts<br>the Markdown of a picture, a shape, a line"]
    n_src_export_mermaid_ts["src/export/mermaid.ts<br>the Mermaid of a picture: flowchart, sequence, class, C4, quadrant"]
    n_src_export_excalidraw_ts["src/export/excalidraw.ts<br>the Excalidraw scene, and the router of the lines around the shapes"]
  end
  subgraph n_diagram["diagram — the placed picture"]
    n_src_diagram_ts["src/diagram.ts<br>the Diagram types and the layout: ranks, barycentre, lanes"]
    n_src_layouts_ts["src/layouts.ts<br>the saved drawings of the editor"]
  end
  subgraph n_core["core — the analysis: files to facts to graph"]
    n_src_analyze_ts["src/analyze.ts<br>one analysis: list, extract (cached), build the graph"]
    n_src_graph_ts["src/graph.ts<br>facts to graph: modules, nodes, imports, resolved calls, gaps"]
    n_src_intent_ts["src/intent.ts<br>the contract: parse and write ARCHITECTURE.md, check the code against it"]
    n_src_cache_ts["src/cache.ts<br>the fact cache, keyed by content hash and extractor version"]
    n_src_options_ts["src/options.ts<br>the options of a picture, described once for the CLI, the API and the page"]
  end
  subgraph n_extract["extract — the language frontends on tree-sitter"]
    n_src_extract_ts_ts["src/extract/ts.ts<br>TypeScript and JavaScript facts"]
    n_src_extract_facts_ts["src/extract/facts.ts<br>the FileFacts contract every frontend fills"]
    n_src_extract_pool_ts["src/extract/pool.ts<br>extraction on worker threads"]
    n_src_extract_grammars_ts["src/extract/grammars.ts<br>the grammars and their WASM files"]
    n_src_languages_ts["src/languages.ts<br>the languages archdiff reads and their extensions"]
  end
  subgraph n_tests["tests — behaviour through the real CLI, HTTP API and page"]
    n_tests_cli_test_ts["tests/cli.test.ts<br>the commands on the fixtures"]
    n_tests_routing_test_ts["tests/routing.test.ts<br>the layout and the router: no line through a shape"]
  end
  subgraph n_scripts["scripts — build and pack"]
    n_scripts_build_web_mjs["scripts/build-web.mjs<br>bundles the page into dist/web"]
    n_scripts_copy_wasm_mjs["scripts/copy-wasm.mjs<br>copies the grammar WASM files into dist"]
  end
  n_bin_archdiff_js --> n_src_cli_ts
  n_src_cli_ts --> n_src_server_ts
  n_src_cli_ts --> n_src_views_ts
  n_src_cli_ts --> n_src_export_index_ts
  n_src_cli_ts --> n_src_diagram_ts
  n_src_cli_ts --> n_src_analyze_ts
  n_src_server_ts --> n_src_routes_pictures_ts
  n_src_server_ts --> n_src_routes_agent_ts
  n_src_server_ts --> n_src_views_ts
  n_src_server_ts --> n_src_export_index_ts
  n_src_server_ts --> n_src_diagram_ts
  n_src_server_ts --> n_src_analyze_ts
  n_src_routes_pictures_ts --> n_src_markdown_ts
  n_web_src_app_ts --> n_src_options_ts
  n_src_cli_ts --> n_src_options_ts
  n_src_views_ts --> n_src_views_more_ts
  n_src_views_ts --> n_src_pipeline_ts
  n_src_views_ts --> n_src_metrics_ts
  n_src_views_ts --> n_src_cycles_ts
  n_src_pipeline_ts --> n_src_shape_ts
  n_src_views_ts --> n_src_shape_ts
  n_src_views_ts --> n_src_intent_view_ts
  n_src_views_ts --> n_src_diagram_ts
  n_src_views_ts --> n_src_graph_ts
  n_src_diff_ts --> n_src_export_mermaid_ts
  n_src_diff_ts --> n_src_analyze_ts
  n_src_intent_view_ts --> n_src_intent_ts
  n_src_export_index_ts --> n_src_diagram_ts
  n_src_markdown_ts --> n_src_analyze_ts
  n_src_layouts_ts --> n_src_cache_ts
  n_src_analyze_ts --> n_src_graph_ts
  n_src_analyze_ts --> n_src_intent_ts
  n_src_analyze_ts --> n_src_extract_pool_ts
  n_src_graph_ts --> n_src_extract_facts_ts
  n_tests_cli_test_ts --> n_src_flow_ts
  n_tests_routing_test_ts --> n_src_views_ts
  n_tests_routing_test_ts --> n_src_export_excalidraw_ts
  n_tests_routing_test_ts --> n_src_diagram_ts
  n_tests_routing_test_ts --> n_src_analyze_ts
  n_scripts_copy_wasm_mjs --> n_src_extract_grammars_ts
```

The page (`web/src`) imports the table of picture options from `src/options.ts` (free of Node, bundled into the page) and only types from `src/diagram.ts` and `src/scene.ts`, which erase at build time. Tests import whatever they test. `src/routes/context.ts` imports the `ServeOptions` type back from `server.ts`: a type, inside one layer.
