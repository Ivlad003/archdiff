Feature: Reviewing a change by its architecture
  The diff of two revisions as counts, a picture and Markdown, for pull requests.

  Scenario: A new dependency between layers fails the review
    Given a repository committed on main
    And a change that makes a routes module import a db module
    When I run "archdiff review --base HEAD"
    Then the exit code is 1
    And the Markdown names "+routes→db"

  Scenario: The marks lie over a layer view
    Given a change that edits "src/lib/log.ts" and adds a function to it
    When I run "archdiff diagram layer:lib --changes --base HEAD --depth 0"
    Then "src/lib/log.ts" carries the changed mark
    And "src/lib/orders.ts" carries no mark

  Scenario: Only the change and its neighbours
    Given the same change
    When I run "archdiff diagram layer:lib --changes --base HEAD --only-changes"
    Then the picture holds only "src/lib/log.ts" and "src/lib/orders.ts"

  Scenario: Outside git
    Given a directory that is not a git repository
    When I run "archdiff review"
    Then the exit code is 2
    And stderr says "is not a git repository"

  Scenario: Several heads against one base
    Given branches a and b off main
    When I run "archdiff compare --heads a,b,WORKTREE"
    Then one picture holds the union of their changes
    And every changed module carries a glyph per head
