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

The system SHALL, on a tap on a shape, show its Markdown page (declarations folding open to their calls and code) and its code with the shape's lines highlighted (every line of a function, however long); on a second tap, open the shape's own view: a layer to its modules, a module to its inside, a function to its calls. Breadcrumbs SHALL lead back up, Backspace back.

#### Scenario: A long function

- **WHEN** a function spanning lines 493 to 676 is tapped
- **THEN** the Code tab shows the file scrolled to line 493 with 184 lines highlighted

### Requirement: A tap on a line says where it leads

The system SHALL, on a tap on a line, light it with its two ends and show its page: what it joins, the imports and calls behind it with their `file:line`; several lines under one tap SHALL be listed to pick from; "follow" (or Shift+tap) SHALL light the chain onward and list it; the line under the pointer SHALL light on hover.

#### Scenario: A bundle of lines

- **WHEN** five lines run within eight pixels of the tap
- **THEN** the panel says "5 lines under the tap" with each as a button, the nearest shown

### Requirement: The canvas shows the picture the link names

The system SHALL draw the picture of the link on one canvas, however fast the link changes: a view opened while the first picture is still mounting the canvas waits for that canvas, and a picture that comes after a newer link is dropped.

#### Scenario: Links faster than the pictures

- **WHEN** a reader opens a view while the first picture is still mounting the canvas, and a slow picture is overtaken by a quick one
- **THEN** the page holds one canvas, and it shows the picture of the last link

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

### Requirement: The project map shows where the picture sits

The system SHALL open, on **project** or `p`, a map of the whole repository over the canvas (`GET /api/graph`): a dot per module (per directory above 400 modules) coloured by layer and sized by lines, a line per import, laid out by forces; hover SHALL name a dot and light its neighbours, the dots of the current picture SHALL wear a ring, a click SHALL open the module's view, Shift+click its focus view, a double click its inside; layer chips SHALL hide layers and a search box SHALL find a module; Escape SHALL close it.

#### Scenario: A dot opens its module

- **WHEN** the map is open and the dot of `store.ts` is clicked
- **THEN** the map closes and the link holds `module:src/db/store.ts`

### Requirement: Sideways navigation

The system SHALL show a picked shape's neighbours in this picture as chips (← what imports or calls it, → what it imports or calls) under the tabs; a click picks the neighbour, Shift+click opens its own view; the arrow keys walk the same way (→ ← along the arrows, ↑ ↓ along the lane) and Enter goes into the picked shape.

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

The system SHALL answer, outside a field and the editor and with no Ctrl, Alt or Cmd held: `/` focuses find, `v` the filter of the views (showing the left panel), `o` opens the options, `p` the project map, `0` fits, Backspace goes back, the arrows walk from the picked shape, Enter goes into it, `s` splits, `m` and `d` turn mix and dim on and off, `l` flips the lanes, `e` edits, Escape clears the selection (or closes the menu and the project map first); Ctrl+B and Ctrl+] SHALL fold the left and the right panel, Ctrl+S save a drawing. In a review or a comparison the keys of the tools (`p`, `s`, `m`, `d`, `e`) SHALL do nothing.

#### Scenario: Find and filter

- **WHEN** `/` is pressed on the canvas, then Escape, then `v`
- **THEN** find has the focus with nothing typed into it, then the filter of the views has it

#### Scenario: Dim from the keyboard

- **WHEN** `d` is pressed and a shape is tapped, then `d` again
- **THEN** all but the shape and its neighbours fade, then nothing is faded

### Requirement: The browser remembers the reader's choices

The system SHALL remember in the browser, and only there, the zoom and place of every view, the folded side panels, a hidden minimap, the theme (the system's at first) and the options kept with *remember as defaults*; the options menu SHALL offer the presets of who reads — reviewer (the changes and the tests overlay), newcomer (one step deep, thirty shapes) and architect (the heat, sixty shapes, lines of weight two) — and *reset*, which forgets the remembered defaults and sets every option of the picture back to the built-in one (opened modules, hidden lanes and type-only imports too). Both SHALL say what they did once the picture is drawn again. A private window without storage SHALL work the same, forgetting.

#### Scenario: Back to a view

- **WHEN** a reader zooms into a view, opens another and comes back
- **THEN** the view opens at the zoom and place it was left
