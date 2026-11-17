Feature: The contract: ARCHITECTURE.md
  The intended architecture as one Mermaid flowchart that people and agents read and write.

  Scenario: A project from scratch
    When I run "archdiff new shop-api --lang ts --template api"
    Then the directory holds package.json, tsconfig.json, archdiff.json, ARCHITECTURE.md, README.md and .gitignore
    And there is one commit on main
    And "archdiff diagram intent" draws four planned modules in lanes routes, services, domain and db
    And "archdiff check" exits 0 and lists four planned modules

  Scenario: An import against the contract
    Given the shop-api project with health.ts in routes importing store.ts in db
    And no arrow from routes to db in ARCHITECTURE.md
    When I run "archdiff check"
    Then the exit code is 1
    And the report says "`src/routes/health.ts:2` imports `src/db/store.ts`: layer **routes** → **db** is not in the intent"

  Scenario: An old repository adopts the contract with a baseline
    Given code with two imports against the contract
    When I run "archdiff check --baseline"
    Then archdiff-baseline.json lists the two violations by rule, importing module and imported module
    And "archdiff check" exits 0 and lists them under "Known violations (2)"

  Scenario: A new violation fails the check beside the known ones
    Given a baseline with two known violations
    And a third import against the contract
    When I run "archdiff check"
    Then the exit code is 1
    And the report lists the third under "New violations (1)" and the others under "Known violations (2)"

  Scenario: A known violation keeps its place when its line moves
    Given a baseline with two known violations
    When lines are added above the imports
    Then "archdiff check" exits 0

  Scenario: The baseline shrinks as the code is fixed
    Given a baseline with two known violations
    When one of the imports is removed
    Then "archdiff check" exits 0 and names the entry under "Fixed since the baseline (1)"
    And "archdiff check --baseline" writes the file with one violation

  Scenario: A design note becomes the contract
    Given a Markdown note with a Mermaid flowchart whose subgraphs are http and app
    When I run "archdiff import note.md"
    Then ARCHITECTURE.md holds that flowchart
    And archdiff.json's layers start with http and app

  Scenario: The drawing goes into the contract before the agent builds it
    Given a drawing on layer:lib with a shape "src/lib/refunds.ts" and an arrow from orders.ts to it
    When I press "code this"
    Then ARCHITECTURE.md names src/lib/refunds.ts in lib with the arrow
    And the task tells the agent to build "src/lib/refunds.ts" and the import

  Scenario: The agent asks, the reader answers
    Given an agent that asks "Which store should orders use?" with options in memory, SQLite and Postgres
    When I run a task in the Chat tab
    Then the question shows three buttons
    When I press "SQLite"
    Then the agent's session resumes with "SQLite"

  Scenario: Round trip of the contract
    Given a contract with entities in a label such as "&lt;string | null&gt; &amp; retries"
    When it is written and read again
    Then the layers, modules, functions and edges are the same
    And the prose before and after the block is unchanged
