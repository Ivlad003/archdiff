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

The system SHALL add a shape to the selection on a tap with Shift, Ctrl or Cmd held (and take it out on another), count the editor's own box selection the same way, light the selected shapes, show two as the shortest chain of lines between them and more as a list with the lines among them, and offer in a strip under the tabs *ask about them* (the Chat tab's question row with the shapes attached), *dim others* and *clear* (Escape). A right click SHALL open a menu: on a shape, its own view, its focus view, its impact (a module, a function or a class: what a change to it reaches), its logic (a function), the other pictures of its subject, the changes to suppose of it (a module deleted or moved, a top-level function split off: the what-if specification), adding it to the selection, asking the agent about it, dimming all but its neighbours, its code and its name to copy; on a line, where it leads and the chain onward; on the empty canvas, a question about the picture, the project map, fit, clear and edit.

#### Scenario: Three shapes

- **WHEN** `orders.ts` is tapped, then `log.ts` and `store.ts` with Ctrl held
- **THEN** the panel says "3 shapes selected" with the three lines among them, and the strip reads "3 selected"

#### Scenario: The menu of a module

- **WHEN** a module shape is right-clicked and "Focus: everything joined to it" is chosen
- **THEN** the link holds `focus:<module>` and the title starts "Everything joined to"

#### Scenario: The impact of a module, from its menu

- **WHEN** a module shape is right-clicked and "Impact: what a change to it reaches" is chosen
- **THEN** the link holds `impact:<module>`, the title starts "Impact of" and the picture has the module in its middle lane


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

The system SHALL reload the picture when a source file of any language the analysis reads changes, and when the checkout moves (a commit, a switch of branch, a reset — where `.git` is a directory), (`--no-watch` turns this off) and after every agent run; a picture asked for after a change SHALL be drawn from the new analysis. When the server cannot follow the files (the system's file watchers used up), it SHALL say so on its first lines, in `/api/views` and in the page's stats, rather than stay silent.

#### Scenario: A file changes

- **WHEN** a source file is saved while the page is open
- **THEN** the picture reloads within a second and the reason names the file

#### Scenario: A Python file is added

- **WHEN** `src/lib/tool.py` is written while the page shows the lib layer
- **THEN** `/api/changes` names it and the next picture of the layer holds it

### Requirement: Guided tours are recorded and played

The system SHALL keep guided tours as files of the repository — `.archdiff/tours/<name>.json`, or under the directory archdiff.json names as `"tours"` — each a title and a list of steps: the link of a view with its options (the hash of the page without the tour's own parameters, every option that differs from the built-in one written), the IDs of the shapes selected, and a note in Markdown; `GET /api/tours` SHALL list them with the directory, `GET /api/tour?name=` read one, `POST /api/tour?name=` save one whole and `POST /api/tour/delete?name=` remove one, a name that is no file's name, a step without a view's link and a file that does not read as a tour each refused with the reason. The header's *tours* menu SHALL list the tours, play one from its first step, remove one after asking, and start the recording of a new one by its name. While the link names a tour (`tour=<name>&step=N`) a bar under the title SHALL show its title (renamed on a press), its steps to pick from, a button to the previous and the next step, the note of the step rendered, and the recording: *add step* SHALL keep the picture shown now with its options and the selection under a note typed there, after the step shown, and show it as the new step with its selection; *✎ note* SHALL rewrite the note of the step shown; *remove* SHALL take the step out after asking; *link* SHALL copy the address that names the tour and the step alone; ✕ SHALL leave the tour with the picture kept. That address, opened, SHALL become the step's own link in place and select the step's shapes once its picture is drawn. A link of a tour SHALL take no default the browser remembers for the options it leaves out. A reader who opens another picture or other options keeps the tour in the link; the bar SHALL say the picture is away from the step, and the step's button or the list SHALL lead back. `.` and `,` SHALL step through a tour that is open, before any other walk. The second picture of a split SHALL show no bar of the tour, whatever the address it was given says.

#### Scenario: Two steps recorded

- **WHEN** a reader names a tour "intro", presses *add step* on the layers with a note, opens a module with the storages overlay, taps the store and presses *add step* with another note
- **THEN** `.archdiff/tours/intro.json` holds the steps `view=layers` and `view=module%3A…&overlay=storages` with the store selected and both notes, and the bar lists "1 of 2" and "2 of 2" with the first words of each note

#### Scenario: The shared link

- **WHEN** `#tour=intro&step=2` is opened in a browser that remembers the tests overlay as a default
- **THEN** the module's picture is drawn with the storages overlay alone, the store is selected, the note of the step is shown, and the address is the step's own link followed by `tour=intro&step=2`

### Requirement: A slider steps through the commits of a range

The system SHALL show, on a review and on the timeline, a bar with the commits of the range: a list, a button to the previous and the next commit, a slider over the commits whose left end is the whole range (the thumb names the commit it is over while dragged; let go, that commit is opened), and a play button that opens the next commit by itself once the picture of this one is drawn and the pace has passed — slow, normal or fast, of a select — until the last commit, a press, a pick by hand or a view without the bar. On a review a commit SHALL be its own change against the one before it, the bar keeping the range. On the timeline a commit SHALL be the code as it was then (`at=<sha>` in the link, which a link to another view drops): the map with what the commit did marked, the title naming the commit and its place, the page's code that commit's, the editor off. Beside the slider three buttons SHALL switch the overlays read from git — churn, coupling, owners — which the options hold as boxes too. A step to a commit SHALL take under a second on the sample fixture. `.` and `,` SHALL step as the buttons do and `k` SHALL play and pause.

#### Scenario: The timeline played

- **WHEN** the timeline of four commits is open, the pace is set to fast and `k` is pressed
- **THEN** the picture is the map at the first commit, then at each of the next, the slider moving with it, and at the fourth the play ends by itself

#### Scenario: The overlays at a commit

- **WHEN** the slider is let go on the third commit and churn, coupling and owners are pressed
- **THEN** the link holds `at=` that commit and `overlay=churn,coupling,ownership`, the two modules changed together twice by then are joined by a dashed line without an arrowhead, and each module names its main author

### Requirement: The board of the uncommitted changes is walked

The system SHALL open the board of the uncommitted changes (`view=changes`) from the picture select, the views list and the key `c`, and show under the title a bar with the steps of its walk — the whole board, then every group in reading order, each with its place, its layer and directory and the count of its modules — a button to the previous and one to the next step, and what the board is compared against. A step SHALL open the group's own picture (`changes:<layer>:<dir>`) and bring its page, which ends with the group's diff, to the Markdown tab (a drawer opens for it where the details are one); the diff SHALL be read by its signs — the lines added, removed and the heads of the hunks each in their colour. `.` and `,` SHALL step forward and back; past either end the line under the picture SHALL say so. The board SHALL be drawn again by the live reload, and its bar filled anew from every picture: a group that is no longer changed while its picture is open SHALL be named as such in the bar, with the walk leading on from it. The board SHALL not be drawn on, and SHALL keep the Chat tab.

#### Scenario: The walk

- **WHEN** the board shows a changed route and a changed library, and `.` is pressed twice, then again, then `,`
- **THEN** the canvas shows the route's group and its diff with the added lines in green, then the library's group with the function added, the one changed and the one removed marked; then the line under the picture says "the last group of the walk"; then the route's group is back

#### Scenario: The board follows the working tree

- **WHEN** another file is saved while the board is open, and then everything is committed
- **THEN** a third group joins the walk within a second or two, and after the commit the board says there is nothing to walk

### Requirement: The page's modules take the page as their context

The system SHALL keep the page's parts in modules of their own — the title and the reason, the side panels, what a tap picks, the menu, the canvas and the drawing, the toolbar, the minimap, the options, the views list, the export menu, the review, the keys, and the tabs of the flow, the chat and the spec — that reach the current picture's shapes, lines and mocks, the canvas, the mode and the views through one bound context (`page.ts`); `app.ts` holds the current picture, loads it and hands the canvas's taps to the picking. The Flow tab SHALL offer ▶ run, the Chat tab *run checks*, and the options the *instability* overlay.

#### Scenario: The page loads

- **WHEN** the page opens on the sample repository
- **THEN** the views list, the canvas and every tab work as before the split, and the page tests pass

### Requirement: The panels give way to the canvas

The system SHALL fold each side panel away and back from the header's button, the tab on the centre's edge beside it and its key (Ctrl+B, Ctrl+]), SHALL give it the width its edge is dragged to (folded away when dragged well past its narrowest, the page's own width on a double click), and SHALL remember both in the browser. Where the window has no room to dock a panel beside a centre of 730 pixels — the right panel first, the left one when it alone leaves less — the panel SHALL be a drawer: out of sight and out of the Tab key's way until asked for, then laid over the canvas, which keeps its width and the picture's place. The right drawer SHALL open for what a tap picks (a shape, a line, a selection, the code, a question for the agent) and go when nothing is picked any more, unless the reader opened it; a shape picked where the drawer opens SHALL be moved clear of it with its picture, which goes back where it was when the drawer goes, unless the reader moved it since; the left drawer SHALL go once a view is picked or the centre is pressed. The full canvas (`f`, the button at the end of the title; remembered) SHALL make both panels drawers whatever room the window has. A docked panel the reader folded away SHALL stay away on a pick, its tab marked until it is shown. The canvas toolbar SHALL fold to the picture, show as and find — on the reader's press (remembered), else by itself on a canvas under 860 pixels — keeping a tool that is on in sight; the legend SHALL list the kinds of shape and of line of the picture shown and the marks of a change on it, drawn by the looks the canvas draws them with, and hide on the reader's press (remembered); the menus of the page (options, export, lanes) SHALL close on a press outside them and on Escape, one open at a time; the note at the top of the Chat, the Flow and the Spec tab SHALL fold away (remembered).

#### Scenario: A window with the room

- **WHEN** the tab on the details' edge is pressed in a window 1900 pixels wide, a shape is tapped, and Ctrl+] is pressed
- **THEN** the canvas is wider by the panel's 420 pixels and the browser remembers the fold; the tab is marked; the panel is back and the mark gone

#### Scenario: A window without the room

- **WHEN** the window is 1300 pixels wide and a shape is tapped, then Escape is pressed
- **THEN** the details open over the canvas with the shape's page, the canvas as wide and the picture as large as before; then they are gone and nothing is selected

#### Scenario: The full canvas

- **WHEN** `f` is pressed in a window 1900 pixels wide, and again
- **THEN** the canvas is 1900 pixels wide with both panels drawers; then both are docked as they were

#### Scenario: The legend is of the picture

- **WHEN** the whole map is shown, then a function's logic
- **THEN** the legend reads module, the import and the import of types alone; then the step, the exit and the next step, and no module

### Requirement: The keys

The system SHALL answer, outside a field and the editor and with no Ctrl, Alt or Cmd held: `/` focuses find, `v` the filter of the views (showing the left panel), `o` opens the options, `p` the project map, `0` fits, Backspace goes back, the arrows walk from the picked shape, Enter goes into it, `s` splits, `m` and `d` turn mix and dim on and off, `l` flips the lanes, `[` and `]` step the head through the branches, `b` shows the branches and `c` the board of the uncommitted changes, `.` and `,` step forward and back through what is walked (the steps of a tour that is open, else the groups of the board, else the commits under the slider), `k` plays and pauses the commits under the slider, `e` edits, `f` turns the full canvas on and off, Escape clears the selection and closes an open drawer with it (a menu and the project map close first); Ctrl+B and Ctrl+] SHALL fold the left and the right panel, Ctrl+S save a drawing. In a review, a comparison, a commit's change, the branches and the board of the uncommitted changes the keys of the tools (`p`, `s`, `m`, `d`, `e`) SHALL do nothing.

#### Scenario: Find and filter

- **WHEN** `/` is pressed on the canvas, then Escape, then `v`
- **THEN** find has the focus with nothing typed into it, then the filter of the views has it

#### Scenario: Dim from the keyboard

- **WHEN** `d` is pressed and a shape is tapped, then `d` again
- **THEN** all but the shape and its neighbours fade, then nothing is faded

### Requirement: The browser remembers the reader's choices

The system SHALL remember in the browser, and only there, the zoom and place of every view the reader moved (a view left where the fit put it is fitted again, to the window it is shown in then; a place that no longer shows the picture gives way to the fit), the folded side panels and their widths, the full canvas, a folded toolbar, a hidden legend, a hidden minimap, the pace of the commits' play, the theme (the system's at first) and the options kept with *remember as defaults*; the options menu SHALL offer the presets of who reads — reviewer (the changes and the tests overlay), newcomer (one step deep, thirty shapes) and architect (the heat, sixty shapes, lines of weight two) — and *reset*, which forgets the remembered defaults and sets every option of the picture back to the built-in one (opened modules, hidden lanes and type-only imports too). Both SHALL say what they did once the picture is drawn again. A private window without storage SHALL work the same, forgetting. A tour is no choice of the browser: it is a file of the repository, and a link of a tour reads the options it leaves out as the built-in ones.

#### Scenario: Back to a view

- **WHEN** a reader zooms into a view, opens another and comes back
- **THEN** the view opens at the zoom and place it was left

### Requirement: The settings window

The system SHALL open, from *agents & keys…* beside the Chat tab's picker, a window over the page with the user's settings and the file they are kept in: every agent with the program started for it or why it cannot run; for a built-in agent a field for its program and one for its model, and for Claude Code a box *through OpenRouter*; an agent of the user's own added by a name, a command typed as one line (a word with spaces in double quotes), the protocol and the resume flag, and removed by a button; the keys by name with their last characters, a key set by its name and value and forgotten by a button. Every change SHALL be sent at once and the window drawn again from the answer, the field in use keeping the focus; what is refused SHALL be said in the window with nothing changed, and the picker SHALL read the agents again after a change. A key's value SHALL leave its field once it is kept and SHALL appear nowhere on the page. While the window is open the keys of the page SHALL not act; Escape, ✕ and a press beside the window SHALL close it.

#### Scenario: An agent of the user's own

- **WHEN** the reader adds an agent "mine" with the command `"C:\Program Files\nodejs\node.exe" agent.mjs`
- **THEN** the settings file holds its command as two words, the window shows the program started for it, and the picker offers "mine"

#### Scenario: A key typed once

- **WHEN** the reader sets `OPENROUTER_API_KEY` to a value ending in "cdef"
- **THEN** the window lists the key as "set …cdef", the value's field is empty, and the page holds the value nowhere

#### Scenario: The keys of the page wait

- **WHEN** the window is open and the reader presses "f"
- **THEN** the panels stay as they are, and Escape closes the window
