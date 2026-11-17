Feature: A change supposed, not made
  archdiff recomputes the architecture as it would be after a move, a deletion or a split, without touching a file,
  and reports it as a review reports a change, with what it would break said first.
  The scenarios here are the ones tests/cli.test.ts and tests/page.test.ts run on tests/fixtures/sample.

  Background:
    Given the sample repository with layers routes, lib, db and cartridge
    And a contract that allows routes → lib, lib → db and db → lib

  Scenario: A move against the contract
    When I run "archdiff whatif move src/db/store.ts src/routes --json"
    Then the change lands at src/routes/store.ts, in layer routes (now db)
    And the diff removes src/db/store.ts and adds src/routes/store.ts with its two functions
    And src/lib/orders.ts would go against the contract: lib → routes
    And a circle of layers lib ⇄ routes would close
    And the exit code is 1
    And src/db/store.ts is on disk as it was

  Scenario: A move the contract allows
    When I run "archdiff whatif move src/lib/log.ts src/db/log.ts --json"
    Then the layer goes from lib to db, there is no finding and the exit code is 0

  Scenario: A deletion that breaks an import
    When I run "archdiff whatif delete src/lib/log.ts"
    Then "⚠ Broken by it" lists "src/lib/orders.ts:3" importing it and placeOrder calling log
    And the picture marks src/lib/log.ts removed and src/lib/orders.ts with "its import breaks"
    And the exit code is 1

  Scenario: A deletion nothing depends on
    When I run "archdiff whatif delete src/routes/checkout.tsx --json"
    Then nothing breaks, the layer dependency routes → lib goes, and the exit code is 0

  Scenario: A package leaves with its last importer
    When I run "archdiff whatif delete src/db/store.ts --json"
    Then the packages removed are "node:fs"

  Scenario: A deletion takes a violation away
    Given a module src/routes/peek.ts that imports the store against the contract
    When I run "archdiff whatif delete src/routes/peek.ts"
    Then the report says the import would no longer go against the contract
    And the exit code is 0

  Scenario: Without a contract
    Given no ARCHITECTURE.md
    When I run "archdiff whatif delete src/routes/checkout.tsx"
    Then the report says there is nothing to hold the change against

  Scenario: A split whose imports follow the code
    When I run "archdiff whatif split src/lib/orders.ts placeOrder,validate src/lib/place.ts --json"
    Then src/lib/orders.ts imports src/lib/place.ts, which imports the store and the log
    And src/lib/orders.ts no longer imports the log
    And there is no finding

  Scenario: A split that closes a cycle
    When I run "archdiff whatif split src/lib/orders.ts placeOrder src/lib/place.ts"
    Then the report says it would close a circle of modules src/lib/orders.ts ⇄ src/lib/place.ts
    And the exit code is 1

  Scenario: A split into another layer, against the contract
    When I run "archdiff whatif split src/lib/orders.ts findOrder src/routes/find.ts --json"
    Then src/routes/find.ts would go against the contract: routes → db
    And src/lib/orders.ts keeps its import of the store

  Scenario: A class leaves with its methods
    When I run "archdiff whatif split src/lib/orders.ts OrderService src/lib/service.ts --json"
    Then the class and its three members are in src/lib/service.ts
    And the route imports src/lib/service.ts and no longer src/lib/orders.ts

  Scenario: A change that cannot be supposed
    When I run "archdiff whatif move src/nowhere.ts src/db"
    Then the exit code is 2 and stderr says 'whatif: no module "src/nowhere.ts"'
    When I run "archdiff whatif move src/lib/log.ts src/lib"
    Then stderr says "src/lib/log.ts is there already"
    When I run "archdiff whatif split src/lib/orders.ts nope src/lib/x.ts"
    Then stderr says 'src/lib/orders.ts declares no "nope" at its top level'
    When I run "archdiff whatif split src/lib/log.ts log src/lib/x.ts"
    Then stderr says "that is a move"
    When I run "archdiff whatif rename a b"
    Then stderr says 'unknown change "rename"'

  Scenario: The page supposes a change from a shape's menu
    Given the page open on "layer:lib"
    When I right-click log.ts and choose "What if it were deleted"
    Then the link holds "whatif:delete:src/lib/log.ts"
    And the title starts "What if: delete src/lib/log.ts — ⚠ 1 import would break"
    And the edit button is off
    When I right-click findOrder on "inside:src/lib/orders.ts", choose "What if it were split off…" and accept the module offered
    Then the link holds "whatif:split:src/lib/orders.ts#findOrder>src/lib/findOrder.ts"
    And the title ends "nothing would break"
