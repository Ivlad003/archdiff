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

  Scenario: Find, lanes, split, path and minimap
    Given the page open on "layer:lib"
    When I tap orders.ts and Shift+tap log.ts
    Then the panel title is "Path: src/lib/orders.ts → src/lib/log.ts"
    When I type "store" in find and press Enter
    Then the panel title is "src/db/store.ts"
    When I untick the routes lane
    Then the link holds "hide=routes"
    When I press "map" and "split"
    Then the minimap shows and a second picture opens embedded without the header

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
