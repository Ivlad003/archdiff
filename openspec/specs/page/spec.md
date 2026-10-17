# Page Specification

## Purpose

One local web page (`archdiff web`) where a reader walks the pictures: one Excalidraw canvas, the views on the left, the Markdown, code, coverage, flow and chat of what is picked on the right, every option in the link.

## Requirements

### Requirement: The server serves the page and an API on a local port

The system SHALL listen on `--port`, or on 7080 or the next free port above it when none is named, refuse a Host header that is not the server's own, serve the page's files from `dist/web` only, and answer `/api/*` with JSON (an `error` field on failure) or server-sent events for streams.

#### Scenario: The default port is taken

- **WHEN** `archdiff web` starts while another process holds 7080
- **THEN** it listens on the next free port and its first line says `(port 7080 was taken)`

#### Scenario: A named port is taken

- **WHEN** `archdiff web --port 7080` starts while another process holds 7080
- **THEN** it exits 2 with the `EADDRINUSE` error

### Requirement: Every option travels in the link

The system SHALL keep the view, depth, fold limit, weight, hubs, packages, changes, only-changes, overlays, Mermaid type, expanded modules, hidden lanes, review, head and heads in the hash of the URL, so a link opens the same picture; a browser MAY remember defaults for the options a link leaves out.

#### Scenario: A shared link

- **WHEN** a reader opens `#view=layer%3Alib&overlay=storages&limit=1`
- **THEN** the lib layer is drawn with the storages overlay and folded above one shape

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

### Requirement: The canvas has tools

The system SHALL offer on the canvas: a picture select (the pictures of this subject, then the overviews), detail presets minimal / normal / full and depth −/+, mix (a tapped module opens in place), focus (all but a shape and its neighbours dims), the lanes menu, find (`/`, Enter centres the first match or opens the matching view), split (a second embedded picture), a minimap (by itself above 60 shapes), and the shortest path between two shapes on Shift+tap.

#### Scenario: Mix

- **WHEN** mix is on and a module is tapped
- **THEN** the link gains `expand=<module>` and the module is drawn as a lane of its functions

#### Scenario: Path

- **WHEN** a shape is tapped and another is Shift+tapped
- **THEN** the shortest chain of lines between them lights and the panel lists its steps, or says no chain joins them

### Requirement: Sideways navigation

The system SHALL show a picked shape's neighbours in this picture as chips (← what imports or calls it, → what it imports or calls) under the tabs; a click picks the neighbour, Shift+click opens its own view; the arrow keys walk the same way (→ ← along the arrows, ↑ ↓ along the lane) and Enter goes into the picked shape.

#### Scenario: Walking with the keys

- **WHEN** `orders.ts` is picked and → is pressed
- **THEN** a module `orders.ts` imports is picked, centred and shown

### Requirement: Drawing is a mode, saved beside the repository

The system SHALL switch the canvas to Excalidraw's full editor on `✎ edit`, save a drawing to `.archdiff/layouts/<view>.json` on `save`, follow the saved places in the live picture and every export, and merge a fresh picture of the code into the drawing on `re-layout` (shapes that still exist keep their place, strokes stay, stale shapes go).

#### Scenario: Leaving an untouched editor

- **WHEN** the editor is opened and closed without a change
- **THEN** nothing asks to confirm

### Requirement: The page follows the code

The system SHALL reload the picture when a source file changes (`--no-watch` turns this off) and after every agent run.

#### Scenario: A file changes

- **WHEN** a source file is saved while the page is open
- **THEN** the picture reloads within a second and the reason names the file
