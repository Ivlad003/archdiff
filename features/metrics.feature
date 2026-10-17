Feature: Coupling and cohesion
  archdiff gives every module and layer Martin's metrics and a cohesion of its functions, from the graph alone.
  The scenarios here are the ones tests/cli.test.ts and tests/unit.test.ts run on tests/fixtures/sample.

  Scenario: The metrics of the sample
    When I run "archdiff metrics --json"
    Then src/db/store.ts has Ca 1, Ce 0 and instability 0
    And src/routes/checkout.tsx has instability 1 and distance 0
    And the layer lib has 2 modules, Ca 1 and Ce 1

  Scenario: The metrics picture
    When I run "archdiff diagram metrics"
    Then the Markdown holds a quadrantChart and a Modules table
    And the reason names the modules far from the main sequence, when any

  Scenario: The instability overlay
    When I run "archdiff diagram layer:lib --overlay instability"
    Then every module carries "I 0.xx · Ca N" in its label

  Scenario: Cycles say where to cut
    When I run "archdiff diagram cycles --types" on the sample
    Then the type-only circle between src/db/store.ts and src/lib/orders.ts is drawn dashed
    And the lighter line carries "cut: 1 import"
    And the reason names "layers in a circle: db ⇄ lib"
