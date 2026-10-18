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

  Scenario: A question about the picture, and a compact transcript
    Given the page open on "layer:lib" with the fake agent
    When I type "What does this layer do?" in the ask row and press Enter
    Then the transcript's own row reads the question "(with the picture)"
    And the agent's steps fold under one line and the answer is rendered
