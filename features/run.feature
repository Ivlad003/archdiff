Feature: A real run with the storages mocked
  archdiff runs an entry point for real in a child Node process, every function traced and the storage packages mocked, and sets it against the predicted flow.
  The scenarios here are the ones tests/cli.test.ts and tests/web.test.ts run on tests/fixtures/sample.

  Scenario: An order is placed
    When I run "archdiff run calls:src/lib/orders.ts#placeOrder --input '{"id":"o1","total":5}'"
    Then the steps are placeOrder, validate, saveOrder and log, in that order
    And the result is the order
    And no predicted step was missed

  Scenario: The file system is a mock
    When I run "archdiff run calls:src/lib/orders.ts#findOrder --input '{"id":"o1"}' --storages '{"node:fs": {"readFileSync": "nothing"}}' --json"
    Then the storage calls hold node:fs readFileSync("/dev/null")
    And nothing on disk was touched

  Scenario: A thrown error
    When I run "archdiff run calls:src/lib/orders.ts#placeOrder --input '{"id":"o2","total":-1}'"
    Then the exit code is 1
    And the report says "Error: negative"

  Scenario: What cannot run is refused with a reason
    When I run "archdiff run calls:src/lib/orders.ts#OrderService.place"
    Then the report says a method cannot be run on its own

  Scenario: The Flow tab's run
    Given a mock input saved with the drawing of calls:src/lib/orders.ts#placeOrder
    When the page posts /api/flow/run for that view
    Then the steps and the result come back with the Markdown report
    And a view that is not a calls view is refused with 400
