Feature: The blast radius of a change
  archdiff shows what depends on a module or a function before it is changed: its dependents step by step,
  the tests that reach it, and a risk score whose parts are shown.
  The scenarios here are the ones tests/cli.test.ts runs on tests/fixtures/sample.

  Background:
    Given the sample repository with layers routes, lib, db and cartridge

  Scenario: The impact of a module
    When I run "archdiff impact src/db/store.ts --json"
    Then its dependents are src/lib/orders.ts at 1 step and src/routes/checkout.tsx at 2 steps through src/lib/orders.ts
    And they span the layers lib and routes
    And the risk is 47, medium: dependents 3, layers 13, tests 20, instability 0, hotspot 11

  Scenario: A path typed on Windows
    When I run "archdiff impact src\db\store.ts --json"
    Then the report is the one of "src/db/store.ts"

  Scenario: Type-only imports count when asked
    When I run "archdiff impact src/lib/orders.ts --json --types"
    Then src/db/store.ts, which imports its type alone, is a dependent too

  Scenario: A test that reaches it
    Given a test file tests/orders.test.ts that imports src/lib/orders.ts
    When I run "archdiff impact src/db/store.ts --json"
    Then tests/orders.test.ts is a dependent at 2 steps, marked as a test
    And the tests part has 10 points: "reached only through other code: the nearest test is 2 steps away"
    And for src/lib/orders.ts the tests part has 0 points: "1 test imports it directly"

  Scenario: The depth cuts the list, not the score
    Given the same test file
    When I run "archdiff impact src/db/store.ts --json --depth 1"
    Then one dependent is listed
    And the totals and the risk are those of the default depth

  Scenario: The impact of a function
    When I run "archdiff impact src/db/store.ts#saveOrder --json"
    Then its dependents are placeOrder at 1 step, OrderService.place at 2 and the route's action at 3
    And the dependents part says "3 functions depend on it, 1 directly"

  Scenario: A class is reached through its methods
    When I run "archdiff impact src/lib/orders.ts#OrderService --json"
    Then the route's action is a dependent at 1 step

  Scenario: The picture has the subject in the middle
    Given the same test file
    When I run "archdiff diagram impact:src/db/store.ts --format json"
    Then the lanes read "tests that reach it (1)", "the subject", "1 step away (1)", "2 steps away (1)" from left to right
    And every line has a route of its own that runs through no shape
    And the nearer dependent is shaded hotter than the farther one

  Scenario: A subject no test reaches is marked
    When I run "archdiff diagram impact:cartridges/base/cartridge/scripts/hooks/basket.js --format json"
    Then its shape says "no test reaches it" and carries the warning mark

  Scenario: The Markdown
    Given the same test file
    When I run "archdiff impact src/db/store.ts"
    Then the page has the risk as a table of its parts
    And the dependents under "1 step away (1)" and "2 steps away (1)", the second "through `src/lib/orders.ts`"
    And "Tests that reach it (1)" with the test file, named however short the depth
    And every dependent and test with the file and line its import or call is written at

  Scenario: Every changed file is a subject
    Given the repository committed, then src/lib/log.ts and src/db/store.ts changed and the cartridge's hook deleted
    When I run "archdiff impact --changed --json"
    Then the subjects are src/db/store.ts and src/lib/log.ts, the riskier first
    And "since" names the base
    When I run "archdiff diagram impact --format json"
    Then both files stand in the middle lane and src/lib/orders.ts has a line to each

  Scenario: Nothing changed, a subject too many, outside git
    Given the repository committed and unchanged
    When I run "archdiff impact --changed"
    Then the page says "no source file changed since" the base
    When I run "archdiff impact src/lib/log.ts --changed"
    Then the exit code is 2 and stderr says "--changed takes no subject"
    When I run "archdiff impact --changed" outside git
    Then the exit code is 2

  Scenario: A missing subject
    When I run "archdiff impact src/nowhere.ts"
    Then the exit code is 2
    And stderr says 'impact: no module or function "src/nowhere.ts"'
