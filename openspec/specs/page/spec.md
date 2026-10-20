# Page Specification

## Purpose

One local web page (`archdiff web`) where a reader walks the pictures: one Excalidraw canvas, the views on the left, the Markdown, code, coverage, flow and chat of what is picked on the right, every option in the link.

## Requirements

### Requirement: The server serves the page and an API on a local port

The system SHALL listen on `--port` (on `--host`, localhost by default), or on 7080 or the next free port above it when none is named, refuse a Host header that is not the server's own, serve the page's files from `dist/web` only, and answer `/api/*` with JSON (an `error` field on failure) or server-sent events for streams; besides the routes of the page, `GET /api/diagram` (a placed picture with its Markdown) and `GET /api/export` (a picture in any format) SHALL serve other tools, and `GET /api/history?path=` the commits that touched a file (a shape's page in a review).

#### Scenario: The default port is taken

- **WHEN** `archdiff web` starts while another process holds 7080
- **THEN** it listens on the next free port and its first line says `(port 7080 was taken)`

#### Scenario: A named port is taken

- **WHEN** `archdiff web --port 7080` starts while another process holds 7080
- **THEN** it exits 2 with the `EADDRINUSE` error

### Requirement: Every option travels in the link

The system SHALL keep the view (a review and a comparison are views), the picture's options as `src/options.ts` names them (depth, fold limit, weight, hubs, packages, changes, only-changes, overlays, Mermaid type, expanded modules, hidden lanes, lanes), the base, the head and the heads in the hash of the URL, so a link opens the same picture; a browser MAY remember defaults for the options a link leaves out. A value of the link the options table refuses SHALL be left out alone — its option at the default, every other option as the link says — and the line under the picture SHALL name it; a field SHALL write only what the table takes (a fold of 1.5 is 1) and show the value in force when it corrected one.

#### Scenario: A shared link

- **WHEN** a reader opens `#view=layer%3Alib&overlay=storages&limit=1`
- **THEN** the lib layer is drawn with the storages overlay and folded above one shape

#### Scenario: A wrong value in a link

- **WHEN** a reader opens `#view=modules&depth=2&overlay=tests&limit=1.5`
- **THEN** the picture has depth 2 and the tests overlay, the fold is the default, and the line under it starts with `⚠ ignored in the link: limit=1.5 (limit must be a whole number of at least 1)`

#### Scenario: Remembered defaults

- **WHEN** a reader presses "remember as defaults" with storages on, then opens a link without `overlay=`
- **THEN** the storages overlay is on, and the hash does not repeat the default

### Requirement: A tap reads, a second tap goes in

The system SHALL, on a tap on a shape, show its Markdown page (declarations folding open to their calls and code) and its code with the shape's lines highlighted (every line of a function, however long); on a second tap, open the shape's own view: a layer to its modules, a module to its inside, a function to its calls (the function a call tree starts from, whose own view is the picture already, to its logic); a second tap or Enter on a shape that opens nothing SHALL say so on the line under the picture. A second tap SHALL be one pressed within half a second of the first tap's release, by the events' own times, so a page still busy with the first tap does not lose it. Breadcrumbs SHALL lead back up, Backspace back.

#### Scenario: A long function

- **WHEN** a function spanning lines 493 to 676 is tapped
- **THEN** the Code tab shows the file scrolled to line 493 with 184 lines highlighted

### Requirement: A tap on a line says where it leads

The system SHALL, on a tap on a line, light it with its two ends and show its page: what it joins, the imports and calls behind it with their `file:line`; several lines under one tap SHALL be listed to pick from; "follow" (or Shift+tap) SHALL light the chain onward and list it; the line under the pointer SHALL light on hover. A tap's light SHALL stay while the pointer moves on, move to the line or shape tapped next, and go out on a tap on nothing, with the selection and any dim the dim tool does not keep; the editor SHALL show no light.

#### Scenario: The light goes out

- **WHEN** a reader taps a line, moves the pointer away, taps another line, then taps the empty canvas
- **THEN** the first line stays lit until the second is tapped, and after the last tap every line looks as the picture drew it

#### Scenario: A bundle of lines

- **WHEN** five lines run within eight pixels of the tap
- **THEN** the panel says "5 lines under the tap" with each as a button, the nearest shown

### Requirement: The page shows the code at any head

The system SHALL draw every picture that is no change (a review, a comparison, the timeline read revisions of their own) from the code at the link's head — a branch, a tag or a commit, read from git without a checkout — and the views list, the shape's and the line's pages, the Code tab, the coverage and the project map from it too; an empty head is the working tree. The header's head field SHALL offer the branches as it is typed, `[` and `]` SHALL step through them with the same view, and the title SHALL end with "@ head"; `b` SHALL show the branches' picture. A head git does not know SHALL be refused by name. A shape's page in a review and in a commit's picture SHALL read the module at the change's head, at the commit.

#### Scenario: The branches, to go to one

- **WHEN** a reader presses `b`, taps the commit of branch `a` and taps it again
- **THEN** the panel shows the commit's message and files, then the canvas shows "Commit <short>: a: a report — 1 source file changed — ⚠ 1 new layer dependency"; the commit's menu offers the code at that commit, the code of `a` and the review of `a`

#### Scenario: Another branch's modules

- **WHEN** the head field is set to `a`, a branch that added `src/db/report.ts`, on the whole map
- **THEN** the title reads "… @ a", the views list holds `module:src/db/report.ts`, and the Code tab of it shows the branch's file

### Requirement: The list shows every view the server lists

The system SHALL place every view the server lists in a group of the page's list — the overviews, then the subject views of each kind under the group the table of kinds names — so that a kind the table does not place cannot be listed by the server and dropped by the page; the overview picker and the breadcrumbs SHALL follow the same table.

#### Scenario: Every listed view has a group

- **WHEN** the views of the sample, the SCAPI and the machines fixtures are listed
- **THEN** each — `logic:<path>#<fn>`, `intent`, `modules`, `branches`, `apis:<family>`, `postman:<file>` among them — has a group of the list, and every overview key parses to its kind

### Requirement: The canvas shows the picture the link names

The system SHALL draw the picture of the link on one canvas, however fast the link changes: a view opened while the first picture is still mounting the canvas waits for that canvas, and a picture that comes after a newer link is dropped. A picture with nothing to draw SHALL say why in the middle of the canvas, without the minimap; a picture that cannot be drawn SHALL clear the canvas and say why there, never leave the last picture standing for it.

#### Scenario: Links faster than the pictures

- **WHEN** a reader opens a view while the first picture is still mounting the canvas, and a slow picture is overtaken by a quick one
- **THEN** the page holds one canvas, and it shows the picture of the last link

#### Scenario: Nothing to draw

- **WHEN** a reader opens the machines of a repository that has none, then the timeline outside git
- **THEN** the canvas says "Nothing to draw here" with the reason, then "This picture could not be drawn" with git's answer, on an empty canvas

### Requirement: The left panel shows the views as lists or as a folder tree

The system SHALL show, at the reader's choice (a switch at the top of the panel, `t`; remembered in the browser), the lists of views or the repository as a folder tree — the layers, their directories as folders, the modules as files, and a module's functions once it is opened (read from its inside picture) — where a tap on an entry opens its view with the centre as it is, the entry of the current view is lit with the folders above it open, the folders a reader opened stay open across loads, and the filter shows a match with its folders open.

#### Scenario: Down the tree to a function

- **WHEN** the tree is shown, the layer `lib`, `src/` and `lib/` are opened, `orders.ts` is tapped, then its caret, then `placeOrder`
- **THEN** the centre shows `module:src/lib/orders.ts` and then the function's view, each entry lit in turn, and after a reload the tree and its open folders are as they were

### Requirement: The navigation says where the diagram is

The system SHALL mark, in the lists of views and in the folder tree, the entries of the files the picture shown now is of (a dot), SHALL cut the panel to those files on a press (remembered), and SHALL make a rendered page a navigation: its sections fold by their headings (a fold remembered across pages with that heading), a module or a function named in bold opens its view with the centre as it is, and a module's bullet unfolds its functions, each opening its view or its code.

#### Scenario: The files of a module's picture

- **WHEN** `module:src/lib/orders.ts` is shown and *in picture* is pressed
- **THEN** the four modules of the picture carry the dot in the list and the tree, the panel lists them with their layers and directories alone, the page's `db` section folds and stays folded on the next page, and the bold `src/lib/log.ts` opens that module's view

### Requirement: The centre shows the view as the link says

The system SHALL show the view in the centre as the link's `as` says — the canvas (the default), the same picture in 3D (each lane a terrace raised by its order, each shape a block with its footprint and colours of the canvas, each line an arched tube with an arrowhead, every label above its block; the mouse orbits, zooms and pans; a tap on a block picks the shape, a double tap opens its view, `0` fits), its Markdown page, or the code of its subject (the file the view names, a function's lines marked; a view without one shows its page and says so) — with a select of the canvas toolbar; the canvas SHALL stay mounted beneath, and the tools that need it (drawing, mix, dim, split, the project map) SHALL be off meanwhile.

#### Scenario: The same picture in 3D

- **WHEN** the link is `#view=module:src/lib/orders.ts&as=3d`
- **THEN** the centre holds a 3D scene with a block per shape of the picture, a tube per line and a terrace per lane, the select reads 3D, and the edit button is off

#### Scenario: The page and the code

- **WHEN** the select is set to markdown, then to code, then to canvas
- **THEN** the centre shows the view's page (the one the Markdown tab holds), then the module's file line by line, then the canvas alone again with the editor allowed

### Requirement: A picture is fitted where nothing covers it

The system SHALL fit a picture whole into the canvas at a zoom of at most 1: below the toolbar, above the row of the zoom buttons and the reason, and beside the minimap or above it, whichever leaves the picture larger; and fit it again when the canvas changes size (the window, a folded panel) until the reader moves it. A picture bigger than the canvas even at the smallest zoom SHALL start from its beginning (its left and top edges), and the line under it SHALL say so.

#### Scenario: A short window

- **WHEN** the whole map fills the height of the canvas
- **THEN** no shape sits under the toolbar or the minimap, and a taller window fits the map again, larger

#### Scenario: A flowchart ten canvases wide

- **WHEN** the logic of a function with sixty early returns is opened
- **THEN** its start sits at the canvas's left edge, the rest runs off to the right, and the line under the picture says it is bigger than the canvas

### Requirement: The canvas has tools

The system SHALL offer on the canvas: a picture select (the pictures of this subject, then the overviews), detail presets minimal / normal / full (full one step deeper than the view by itself) and depth −/+ (from the view's own depth, without a ceiling, off on a view that goes no depth), mix (a tapped module opens in place), dim (all but a shape and its neighbours dims), the lanes menu and lanes ↔ (rows or columns), find (`/`, Enter centres the first match or opens the matching view), split (a second embedded picture, stacked below 1520 pixels), project (the project map), a minimap (on by default, remembered when hidden; the shapes and lines small with the viewport as a box, moved by a tap or a drag), and the shortest chain of lines between two shapes on Shift+tap.

#### Scenario: Mix

- **WHEN** mix is on and a module is tapped
- **THEN** the link gains `expand=<module>` and the module is drawn as a lane of its functions

#### Scenario: Path

- **WHEN** a shape is tapped and another is Shift+tapped
- **THEN** the shortest chain of lines between them lights and the panel lists its steps, or says no chain joins them

### Requirement: Several shapes can be selected, and every shape has a menu

The system SHALL add a shape to the selection on a tap with Shift, Ctrl or Cmd held (and take it out on another), count the editor's own box selection the same way, light the selected shapes, show two as the shortest chain of lines between them and more as a list with the lines among them, and offer in a strip under the tabs *ask about them* (the Chat tab's question row with the shapes attached), *dim others* and *clear* (Escape). A right click SHALL open a menu: on a shape, its own view, its focus view, its logic (a function), the other pictures of its subject, adding it to the selection, asking the agent about it, dimming all but its neighbours, its code and its name to copy; on a line, where it leads and the chain onward; on the empty canvas, a question about the picture, the project map, fit, clear and edit.

#### Scenario: Three shapes

- **WHEN** `orders.ts` is tapped, then `log.ts` and `store.ts` with Ctrl held
- **THEN** the panel says "3 shapes selected" with the three lines among them, and the strip reads "3 selected"

#### Scenario: The menu of a module

- **WHEN** a module shape is right-clicked and "Focus: everything joined to it" is chosen
- **THEN** the link holds `focus:<module>` and the title starts "Everything joined to"


### Requirement: A peek shows a shape's lines alone

The system SHALL, on a press with Alt held on a shape or a line while reading, show the lines from or to that shape (the line itself for a line) alone and lit, keep the shapes at their ends, fade the other shapes and hide the other lines with their labels, and put everything back when the button or Alt is released or the window loses the keys; the press SHALL neither pick the shape nor pan the canvas.

#### Scenario: Alt held on a module

- **WHEN** Alt and the button are held on `src/lib/orders.ts` in the modules picture
- **THEN** the lines from and to it are lit and whole, every other line is gone, and releasing the button puts every line back as it was, with nothing picked
### Requirement: The project map shows where the picture sits

The system SHALL open, on **project** or `p`, a map of the whole repository over the canvas (`GET /api/graph`): a dot per module (per directory above 400 modules) coloured by layer and sized by lines, a line per import, laid out by forces that keep it together — a dot pushes away only the dots near it, every dot is pulled to the middle and to its layer's, dots do not overlap — and fitted whole into the canvas; hover SHALL name a dot and light its neighbours, the dots of the current picture SHALL wear a ring, a click SHALL open the module's view, Shift+click its focus view, a double click its inside (a click waits for a second one before it opens); layer chips SHALL hide layers and a search box SHALL find a module, empty when `p` opened the map; Escape SHALL close it.

#### Scenario: A dot opens its module

- **WHEN** the map is open and the dot of `store.ts` is clicked
- **THEN** the map closes and the link holds `module:src/db/store.ts`

#### Scenario: A double click goes inside

- **WHEN** the map is open and the dot of `orders.ts` is double-clicked
- **THEN** the map closes and the link holds `inside:src/lib/orders.ts`

#### Scenario: Modules joined to nothing

- **WHEN** a repository has scripts that import nothing and that nothing imports
- **THEN** their dots sit beside the others, and every dot of the map is on the canvas

### Requirement: Sideways navigation

The system SHALL show a picked shape's neighbours in this picture as chips (← what imports or calls it, → what it imports or calls) under the tabs; a click picks the neighbour, Shift+click opens its own view; the arrow keys walk the same way (→ ← along the arrows, ↑ ↓ along the lane) and Enter goes into the picked shape. Its neighbours beyond the picture's depth SHALL follow as dashed chips (◂ before it, ▸ after it): a click opens the neighbour's own picture, Shift+click its focus view. The counts under a shape's corners (◂ N, N ▸) SHALL be tapped as the shape.

#### Scenario: What lies beyond

- **WHEN** the picture of `log.ts` is open and the count "◂ 1" under `orders.ts` is tapped
- **THEN** `orders.ts` is picked, the strip lists `◂ src/routes/checkout.tsx` and `src/db/store.ts ▸` dashed, and a click on the first opens `module:src/routes/checkout.tsx`

#### Scenario: Walking with the keys

- **WHEN** `orders.ts` is picked and → is pressed
- **THEN** a module `orders.ts` imports is picked, centred and shown

### Requirement: Every panel can be copied, and the specification has a tab

The system SHALL copy, with one button beside the tabs, what the active tab shows (the Markdown, the file without line numbers, the coverage, the flow, the transcript, the spec) and say how much was copied. The Spec tab SHALL list `openspec/specs/*/spec.md` and `features/*.feature`, show the picked one, and offer "spec this view" and "review all specs" (the agent's task, through the Chat tab) and "validate" (the OpenSpec CLI).

#### Scenario: Copy the code

- **WHEN** the Code tab shows a file and copy is pressed
- **THEN** the clipboard holds the file's text without line numbers and the button says "copied"

#### Scenario: No specs yet

- **WHEN** the Spec tab opens in a repository without `openspec/`
- **THEN** it says "no openspec/ yet" and "spec this view" is offered

### Requirement: Drawing is a mode, saved beside the repository

The system SHALL switch the canvas to Excalidraw's full editor on `✎ edit`, save a drawing to `.archdiff/layouts/<view>.json` on `save` (Ctrl+S), follow the saved places in the live picture and every export, and merge a fresh picture of the code into the drawing on `refresh` (shapes that still exist keep their place, strokes stay, stale shapes go); leaving the editor with unsaved changes SHALL ask first.

#### Scenario: Leaving an untouched editor

- **WHEN** the editor is opened and closed without a change
- **THEN** nothing asks to confirm

### Requirement: The page follows the code

The system SHALL reload the picture when a source file of any language the analysis reads changes (`--no-watch` turns this off) and after every agent run; a picture asked for after a change SHALL be drawn from the new analysis. When the server cannot follow the files (the system's file watchers used up), it SHALL say so on its first lines, in `/api/views` and in the page's stats, rather than stay silent.

#### Scenario: A file changes

- **WHEN** a source file is saved while the page is open
- **THEN** the picture reloads within a second and the reason names the file

#### Scenario: A Python file is added

- **WHEN** `src/lib/tool.py` is written while the page shows the lib layer
- **THEN** `/api/changes` names it and the next picture of the layer holds it

### Requirement: The page's modules take the page as their context

The system SHALL keep the page's parts in modules of their own — the title and the reason, the side panels, what a tap picks, the menu, the canvas and the drawing, the toolbar, the minimap, the options, the views list, the export menu, the review, the keys, and the tabs of the flow, the chat and the spec — that reach the current picture's shapes, lines and mocks, the canvas, the mode and the views through one bound context (`page.ts`); `app.ts` holds the current picture, loads it and hands the canvas's taps to the picking. The Flow tab SHALL offer ▶ run, the Chat tab *run checks*, and the options the *instability* overlay.

#### Scenario: The page loads

- **WHEN** the page opens on the sample repository
- **THEN** the views list, the canvas and every tab work as before the split, and the page tests pass

### Requirement: The keys

The system SHALL answer, outside a field and the editor and with no Ctrl, Alt or Cmd held: `/` focuses find, `v` the filter of the views (showing the left panel), `o` opens the options, `p` the project map, `0` fits, Backspace goes back, the arrows walk from the picked shape, Enter goes into it, `s` splits, `m` and `d` turn mix and dim on and off, `l` flips the lanes, `[` and `]` step the head through the branches, `e` edits, Escape clears the selection (or closes the menu and the project map first); Ctrl+B and Ctrl+] SHALL fold the left and the right panel, Ctrl+S save a drawing. In a review or a comparison the keys of the tools (`p`, `s`, `m`, `d`, `e`) SHALL do nothing.

#### Scenario: Find and filter

- **WHEN** `/` is pressed on the canvas, then Escape, then `v`
- **THEN** find has the focus with nothing typed into it, then the filter of the views has it

#### Scenario: Dim from the keyboard

- **WHEN** `d` is pressed and a shape is tapped, then `d` again
- **THEN** all but the shape and its neighbours fade, then nothing is faded

### Requirement: The browser remembers the reader's choices

The system SHALL remember in the browser, and only there, the zoom and place of every view the reader moved (a view left where the fit put it is fitted again, to the window it is shown in then; a place that no longer shows the picture gives way to the fit), the folded side panels, a hidden minimap, the theme (the system's at first) and the options kept with *remember as defaults*; the options menu SHALL offer the presets of who reads — reviewer (the changes and the tests overlay), newcomer (one step deep, thirty shapes) and architect (the heat, sixty shapes, lines of weight two) — and *reset*, which forgets the remembered defaults and sets every option of the picture back to the built-in one (opened modules, hidden lanes and type-only imports too). Both SHALL say what they did once the picture is drawn again. A private window without storage SHALL work the same, forgetting.

#### Scenario: Back to a view

- **WHEN** a reader zooms into a view, opens another and comes back
- **THEN** the view opens at the zoom and place it was left
