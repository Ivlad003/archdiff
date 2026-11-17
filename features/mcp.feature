Feature: The architecture asked by a coding agent
  archdiff mcp serves the analysis over the Model Context Protocol on stdin and stdout, so an agent asks while it works.
  The scenarios here are the ones tests/mcp.test.ts runs: on tests/fixtures/sample, and on a copy of it with a contract, two test files and a commit.

  Scenario: The handshake
    Given "archdiff mcp" started on the sample
    When the client sends "initialize" with the protocol version "2025-06-18"
    Then the result names the protocol version "2025-06-18", the tools capability and the server "archdiff" with the package's version
    And "ping" is answered with an empty result

  Scenario: The tools are listed
    When the client sends "tools/list"
    Then the tools are views, diagram, check, may_import, impact and review
    And each has a description, a schema of its arguments and the read-only hint
    And the arguments of diagram are the view, the revisions and every option of the picture

  Scenario: The views and a picture, as the commands print them
    When the agent calls "views"
    Then the text is what "archdiff views" prints
    When the agent calls "diagram" with the view "module:src/db/store.ts", depth 0 and packages
    Then the text is what "archdiff diagram module:src/db/store.ts --depth 0 --packages" prints

  Scenario: Who depends on a function
    When the agent calls "impact" with the target "src/db/store.ts#saveOrder"
    Then placeOrder is 1 step away, OrderService.place 2 and the route's action 3
    And each caller carries the file and the line of its call

  Scenario: The tests to run
    Given a test file that calls placeOrder and one that only imports the store
    When the agent calls "impact" with the target "src/db/store.ts#saveOrder" and depth 1
    Then the callers list holds placeOrder and counts 3 more further away
    And the tests name the first file as calling it, 2 steps away
    And the second as importing its module, 1 step away

  Scenario: An import asked about before it is written
    Given a contract with the arrows routes to lib and lib to db
    When the agent calls "may_import" from "src/lib/orders.ts" to "src/db/store.ts"
    Then the answer starts with "Allowed:" and names the arrow of the contract
    When the agent calls "may_import" from "src/routes/checkout.tsx" to "src/db/store.ts"
    Then the answer starts with "Not allowed:" and says routes may import lib
    When the agent calls "may_import" from "tests/orders.test.ts" to "src/lib/orders.ts"
    Then the answer starts with "Not judged:" and names the layer the contract lacks

  Scenario: The answers follow the agent's edits
    Given the agent called "check" and no import went against the intent
    When the route is edited to import the store
    And the agent calls "check" again
    Then the answer names "src/routes/checkout.tsx:1" as importing "src/db/store.ts" against the intent
    And "review" with the base "HEAD" marks "routes → db" as against ARCHITECTURE.md

  Scenario: Without a contract
    Given the sample, which has no ARCHITECTURE.md
    When the agent calls "check"
    Then the answer is "no ARCHITECTURE.md, nothing to check against (archdiff intent --init)"

  Scenario: A wrong call is refused in the CLI's words
    When the agent calls "diagram" with the view "nope"
    Then the answer is the JSON-RPC error -32602 with the message "archdiff diagram nope" prints
    When the agent calls "diagram" with the argument "dpth"
    Then the answer is the JSON-RPC error -32602 naming the unknown argument and the ones the tool has
    And the next request is still answered

  Scenario: A tool that ran and failed
    Given a directory that is not a git repository
    When the agent calls "review"
    Then the answer is a result marked as an error
    And its text says "is not a git repository"

  Scenario: The input ends
    When the client closes the server's stdin
    Then every request already read is answered
    And the server exits 0 with nothing on stdout but the protocol's messages
