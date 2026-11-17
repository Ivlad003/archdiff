Feature: The logic of a function
  archdiff draws a function's body as a flowchart and lists every path through it as a rule.
  The scenarios here are the ones tests/cli.test.ts and tests/web.test.ts run on tests/fixtures/machines and tests/fixtures/sample.

  Scenario: A loop, a branch and a try
    When I run "archdiff diagram logic:src/checkout.ts#checkout"
    Then the Mermaid is a flowchart TB with a hexagon for the loop and diamonds for rush and try
    And the arrows read each, yes, no, done, ok and error
    And the rules table has "const order of orders: each and rush: yes and try: ok | pay, ship, audit | return shipped"

  Scenario: A switch and a Python match
    When I run "archdiff diagram logic:src/order.ts#pay"
    Then one arrow per case leaves "switch order.status" and the default throws in orange
    When I run "archdiff diagram logic:src/door.py#Door.lock"
    Then one arrow per pattern leaves "match self.state" and "no match" carries on

  Scenario: Every loop and every way out
    Given a loop in a loop, a function returning inside a try with a finally, and loops labelled "outer"
    When I run "archdiff diagram logic:src/grid.ts#grid"
    Then a rule reads "const row of rows: each and const cell of row: each and cell > 0: no | | return 1"
    And the rules of withLock end "acquire, work, release | return work(n)"
    And "continue outer" leads back to the outer loop, "break outer" past it
    And a Python elif leads on to its else, an except that returns runs the finally first

  Scenario: The list of branching functions
    When I run "archdiff diagram logic"
    Then the title is "Logic: 7 functions with branches"
    And "archdiff views" lists "logic:src/checkout.ts#checkout" with 3 branches
    And an unknown function exits 2

  Scenario: Everything joined to a function
    When I run "archdiff diagram focus:src/lib/orders.ts#placeOrder"
    Then placeOrder sits with OrderService.place calling it and validate, saveOrder and log called by it
    And each module is a lane

  Scenario: A tag of a view or of a function's logic
    When "@view:layer:lib and @logic:src/lib/orders.ts#validate" is expanded through the API
    Then the context holds the Markdown of the layer and the rules of validate

  Scenario: A function's logic held against the base
    Given the sample as a repository whose working tree adds a guard to placeOrder and makes validate stricter
    When I run "archdiff diagram logic:src/lib/orders.ts#placeOrder --changes --base HEAD"
    Then the title ends with "changes since HEAD"
    And the page reads "Steps +2 −0 ~0; rules +2 −1." and lists the new decision "readOrder(id)" and its throw
    And the two new steps are marked added in the picture
    When I run it for "validate"
    Then the page lists "~ decision at line 17: + `order.total <= 0`; − `order.total < 0`"
    When I run it for "findOrder"
    Then the page says every step and every rule is as it was
