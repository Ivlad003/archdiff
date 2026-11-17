Feature: The VS Code extension
  archdiff beside the editor: its page in a panel, the picture of this file or this function, the code of what is picked opened in the editor, the contract check as problems.
  The scenarios here are the ones vscode/tests run: the unit tests (npm test in vscode/), and the editor test in a real VS Code on a stand-in archdiff (npm run test:editor).

  Scenario: Which archdiff runs
    Given a workspace with node_modules/.bin/archdiff and another archdiff on the PATH
    Then the workspace's own is the one run
    Given neither, and npx on the PATH
    Then "npx --yes @ivlad003/archdiff" is run
    Given the setting archdiff.command naming a file that is not there
    Then the problem names the setting, and no other archdiff is run

  Scenario: A shim of npm on Windows
    Given node_modules\.bin\archdiff.cmd, the batch file npm writes for a package's command
    Then node.exe is started with the script the batch file names, without a shell
    Given npx as npm's own npx.cmd
    Then node.exe is started with npx-cli.js, then "--yes" and the package

  Scenario: Open shows the page beside the editor
    Given a folder open in VS Code with the extension
    When I run "archdiff: Open"
    Then "archdiff web" starts on the folder on a free port
    And a panel "archdiff — shop" opens in the second column with the page loaded in its frame, hosted
    When the window closes
    Then nothing listens on the server's port

  Scenario: Show this function
    Given the panel open and the cursor inside the function place of src/place.ts
    When I run "archdiff: Show this function"
    Then the page shows "calls:src/place.ts#place" without being loaded again

  Scenario: The function at the cursor is the innermost one
    Given src/lib/orders.ts of the sample, where OrderService spans lines 23 to 31 and its method place lines 25 to 27
    Then line 26 is in "src/lib/orders.ts#OrderService.place"
    And line 23 is in "src/lib/orders.ts#OrderService"
    And line 14, between two functions, is in none

  Scenario: Show this file
    Given the panel open
    When I run "archdiff: Show this file" on src/place.ts from the explorer's menu
    Then the page shows "module:src/place.ts" in the same panel, without being loaded again

  Scenario: A place picked on the page opens in the editor
    Given the panel open beside an editor
    When the page tells its host to open src/other.ts at line 2
    Then src/other.ts is shown in the first column with the cursor on line 2
    And the panel is still in the second column

  Scenario: The contract check as problems
    Given a folder with an ARCHITECTURE.md where src/place.ts imports src/other.ts against the contract on line 1
    When the window opens
    Then line 1 of src/place.ts carries an error of archdiff: "imports src/other.ts: layer app → db is not in ARCHITECTURE.md. Add the arrow there if it is wanted, else move the import."
    When I save a file
    Then the check runs again

  Scenario: The check's report as findings
    Given the JSON "archdiff check --json" prints for one import against the contract
    Then there is one finding, on the importing file and the import's line
    Given no output at all
    Then there is no finding, and no problem
    Given an output that is not a report
    Then the problem says so
