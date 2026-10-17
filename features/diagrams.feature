Feature: Diagrams from the code
  archdiff draws a repository's architecture from its source files, without a model.
  The scenarios here are the ones tests/cli.test.ts and tests/web.test.ts run; they read against the sample fixture (tests/fixtures/sample).

  Background:
    Given the sample repository with layers routes, lib, db and cartridge

  Scenario: Every view answers one question
    When I run "archdiff diagram module:src/lib/orders.ts"
    Then the Markdown starts with "# src/lib/orders.ts"
    And the picture shows what the module imports and what imports it
    And the first line of the Markdown says the question the picture answers

  Scenario: A missing subject is refused plainly
    When I run "archdiff diagram layer:nope"
    Then the exit code is 2
    And stderr says 'no layer "nope"'

  Scenario: Big pictures fold by directory
    When I run "archdiff diagram layer:lib --limit 1"
    Then the picture holds "… 1 in src/db/" and "… 1 in src/routes/"
    And the reason says how many shapes were folded

  Scenario: Hubs become badges
    Given a picture where 7 of 9 modules import "log.ts"
    When the picture is shaped
    Then "log.ts" is not drawn
    And each of its importers carries "+ log.ts"
    And the reason says "hubs as badges, not drawn: log.ts (imported by 7 of 9)"

  Scenario: Overlays lay one more fact over any picture
    When I run "archdiff diagram layer:lib --overlay tests,storages,heat"
    Then "src/db/store.ts" is labelled "no tests", "⛁ the file system" and "2 calls in"
    And it carries the warning mark and a heat value

  Scenario: A module opens in place
    When I run "archdiff diagram layer:lib --expand src/lib/orders.ts"
    Then a lane "inside:src/lib/orders.ts" holds placeOrder and findOrder
    And the import from checkout.tsx lands on OrderService.place
    And "src/db/store.ts" lands on the rest of the module

  Scenario: No line runs through a shape
    When every view of the fixture is laid out and routed
    Then no segment of any line overlaps a shape that is not its own source or target

  Scenario: The whole map
    When I run "archdiff diagram modules"
    Then the title is "Modules: 5 in 4 layers"
    And every module sits in its layer's lane
