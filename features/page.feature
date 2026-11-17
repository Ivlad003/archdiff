Feature: The page
  One canvas, the views on the left, the panels on the right, every option in the link.
  The scenarios here are the ones tests/page.test.ts runs with Playwright and the system Chrome.

  Scenario: A tap reads, a second tap goes in
    Given the page open on "layers"
    When I open the module view of src/lib/orders.ts and tap its shape
    Then the Code tab shows src/lib/orders.ts with placeOrder in it

  Scenario: A tap on a line says where it leads
    Given the page open on "layer:lib"
    When I tap the line from orders.ts to store.ts
    Then the panel title is "src/lib/orders.ts → src/db/store.ts"
    And the panel says "to: src/db/store.ts (module)"
    When I press "follow"
    Then the panel lists the chain onward

  Scenario: The options panel and remembered defaults
    Given the page open on "layer:lib"
    When I tick the storages overlay and set fold above 1
    Then the link holds "overlay=storages" and "limit=1"
    When I press "remember as defaults" and open a link without options
    Then storages is on and the link does not repeat it
    When I press "reset"
    Then the built-in options are back

  Scenario: The canvas toolbar
    Given the page open on "layer:lib"
    When I pick "matrix" in the picture select
    Then the link says "view=matrix"
    When I press "minimal"
    Then the link holds "limit=20", "weight=2" and "depth=1"
    When mix is on and I tap a module
    Then the link holds "expand=" with that module

  Scenario: A peek with Alt held
    Given the page open on "modules"
    When I hold Alt and press orders.ts
    Then only the lines from and to orders.ts show, lit, and the shapes at their ends stay
    When I release the button
    Then every line shows again and nothing is picked

  Scenario: Find, the keys, dim, lanes, split, the chain and the minimap
    Given the page open on "layer:lib"
    When I tap orders.ts and Shift+tap log.ts
    Then the panel title is "Chain: src/lib/orders.ts → src/lib/log.ts"
    When I press "/"
    Then find has the focus and nothing is typed into it
    When I press Escape and "v"
    Then the filter of the views has the focus
    When I press "d" and tap orders.ts
    Then everything but orders.ts and its neighbours fades
    When I press "d" again
    Then nothing is faded
    When I type "store" in find and press Enter
    Then the panel title is "src/db/store.ts"
    When I untick the routes lane
    Then the link holds "hide=routes"
    When I press "minimap" twice and "split"
    Then the minimap hides and shows again, and a second picture opens embedded without the header

  Scenario: Sideways with the chips and the keys
    Given the page open on "modules"
    When I tap orders.ts
    Then the chips read "→ src/db/store.ts" and "← src/routes/checkout.tsx"
    When I press → then ←
    Then orders.ts is picked again
    When I click the checkout.tsx chip and press Enter
    Then the link holds "inside:src/routes/checkout.tsx"

  Scenario: Copy and the Spec tab
    Given the page open on "layer:lib"
    When I press copy
    Then the clipboard holds the Markdown of the picture
    When I tap orders.ts and press copy
    Then the clipboard holds the file without line numbers
    When I open the Spec tab in a repository without openspec/
    Then it says "no openspec/ yet" and offers "spec this view"

  Scenario: Several shapes, the menu and the project map
    Given the page open on "layer:lib"
    When I tap orders.ts, then log.ts and store.ts with Ctrl held
    Then the panel says "3 shapes selected" and the strip reads "3 selected"
    When I right-click orders.ts and choose "Focus: everything joined to it"
    Then the link holds "focus:src/lib/orders.ts"
    When I press p
    Then the project map opens with a dot per module
    When I click the dot of store.ts
    Then the map closes and the link holds "module:src/db/store.ts"

  Scenario: The impact of a shape, from its menu
    Given the page open on "layer:lib"
    When I right-click orders.ts and choose "Impact: what a change to it reaches"
    Then the link holds "impact:src/lib/orders.ts" and the title starts "Impact of"
    And the lanes read "the subject" and "1 step away (1)", with checkout.tsx in the second

  Scenario: A question about the picture, and a compact transcript
    Given the page open on "layer:lib" with the fake agent
    When I type "What does this layer do?" in the ask row and press Enter
    Then the transcript's own row reads the question "(with the picture)"
    And the agent's steps fold under one line and the answer is rendered

  Scenario: The panels give way to the canvas
    Given the page open on "modules" in a window 1900 pixels wide
    When I press the tab on the details' edge
    Then the canvas is 420 pixels wider and the browser remembers the fold
    When I drag the details' edge 150 pixels into the canvas
    Then the details are 570 pixels wide, and a double click on the edge gives 420 back
    When the window is 1300 pixels wide and I tap a shape
    Then the details open over the canvas with the shape's page, and Escape sends them away
    When the window is 960 pixels wide and I press "v", then pick a view
    Then the views open over the canvas on their filter, and go once the view is picked
    When I press "f" in a window 1900 pixels wide
    Then the canvas is 1900 pixels wide, and "f" again docks both panels as they were

  Scenario: A guided tour is recorded, played and shared
    Given the page open on "layers"
    When I open "tours", type the name "intro" and press Enter
    Then the bar of the tour says "recording"
    When I press "add step" and keep the note "The **layers** of the sample."
    Then the link holds "tour=intro&step=1" and the note shows "layers" in bold
    When I open the module of orders.ts with the storages overlay, tap store.ts and add a step with a note
    Then .archdiff/tours/intro.json holds two steps, the second with the overlay in its link and store.ts selected
    When I press ","
    Then the layers are shown with the first note
    When I open "#tour=intro&step=2" in a browser that remembers another overlay
    Then the module is shown with the storages overlay alone, store.ts selected and the second note

  Scenario: The slider over the commits of a range
    Given a branch of four commits by two authors, open on "timeline"
    When I press "."
    Then the canvas shows the map of the code at the first commit, the module it added marked, and the link holds "at="
    When I let the slider go on the third commit and press ›
    Then the title ends "commit 4 of 4" within a second
    When I press "churn", "coupling" and "owners"
    Then the modules are shaded by their changes, the two changed together are joined by a dashed line, and each names its author
    When I open the whole range, set the pace to fast and press "k"
    Then the commits follow by themselves and the play ends at the fourth
    When I open the review and let the slider go on the second commit
    Then the review is that commit's own change against the one before it

  Scenario: The board of the uncommitted changes
    Given a repository with a changed route, a changed library module and a new one, not committed
    When I press "c"
    Then the title reads "Uncommitted changes: 3 modules in 2 groups — 3 source files changed"
    And the walk lists the whole board, then "routes · src/routes/", then "lib · src/lib/"
    When I press "."
    Then the canvas shows the route's group, and the Markdown tab its diff with the added lines in green
    When I press "." twice
    Then the library's group is shown and the line under the picture says "the last group of the walk"
    When I save another file
    Then a third group joins the walk
    When I commit everything
    Then the board says there is nothing to walk

  Scenario: The toolbar folds, the legend is of the picture, the menus close
    Given the page open on "modules"
    Then the legend reads "module", "A → B: A imports B" and "types only"
    When I press "tools" on the toolbar
    Then the picture, show as and find stay, and the detail buttons are gone until I press it again
    When I open the export menu, then the options
    Then one menu is open, and Escape or a press outside closes it

  Scenario: The settings window places the agents and keeps the keys
    Given the page open on "layers" with no agent installed
    When I open the Chat tab and press "agents & keys…"
    Then the window names the settings file and lists Claude Code, Cursor, Codex and OpenCode, each with why it cannot run
    When I add the agent "mine" with a command that runs the fake agent
    Then the window shows the program started for it and the picker picks "mine"
    When I set the key "OPENROUTER_API_KEY" to a value ending in "cdef"
    Then the key is listed as "set …cdef" and its value is nowhere on the page
    When I set the key "NODE_OPTIONS"
    Then the window says a key is named …_KEY or …_TOKEN and lists one key
    When I press "f", then Escape
    Then the panels stay as they are and the window is closed
    When I run the task "Say done."
    Then the answer "Done." is rendered
