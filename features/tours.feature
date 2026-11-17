Feature: Guided tours through the pictures
  A tour is a list of steps — a view's link with its options, the shapes selected, a note in Markdown — kept as a file of the repository, recorded and played on the page, written as Markdown in the terminal.
  The scenarios here are the ones tests/cli.test.ts and tests/web.test.ts run; the page's are in page.feature.

  Background:
    Given the sample repository with layers routes, lib, db and cartridge

  Scenario: A tour as Markdown
    Given ".archdiff/tours/intro.json" with a step on "layers" selecting "lib" and a step on "module:src/lib/orders.ts" with "overlay=storages"
    When I run "archdiff tour intro"
    Then the Markdown is headed by the tour's title and says how many steps it has
    And step 1 holds its note, the layers as Mermaid and "Picked: **lib**."
    And step 2's picture labels the store "⛁ the file system"

  Scenario: A step whose picture is gone
    Given a tour with a step on a module the code no longer has
    When I run "archdiff tour intro"
    Then the exit code is 0
    And that step says its picture could not be drawn, with the reason

  Scenario: No such tour
    When I run "archdiff tour other"
    Then the exit code is 2
    And stderr names the tours there are

  Scenario: A directory the repository commits
    Given archdiff.json with "tours": "docs/tours"
    When a tour "intro" is saved through the API
    Then the file is "docs/tours/intro.json"
    And "archdiff tour intro" reads it from there

  Scenario: What is no tour is refused
    When a tour is saved with a step whose link names no view
    Then the API answers 400 with "the link of step 1 names no view (view=<key>)"
    And no file is written
