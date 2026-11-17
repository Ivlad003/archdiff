Feature: The languages whose packages are many files
  archdiff reads Go beside TypeScript, JavaScript, Python, Rust and PHP: an import names a package, and the file that declares what is used is the dependency.
  The scenarios here are the ones tests/cli.test.ts and tests/extract.test.ts run on tests/fixtures/polyglot.

  Background:
    Given the polyglot repository with a Go module "example.com/shop" under go/

  Scenario: A Go package is its directory
    When I run "archdiff diagram dir:go --format mermaid"
    Then "go/internal/orders/orders.go" imports "go/internal/orders/validate.go" and "go/internal/store/store.go"
    And "go/cmd/shop/main.go" imports "go/internal/httpapi/handler.go" but not "go/internal/orders/validate.go"
    And "archdiff analyze" reports 0 unresolved imports

  Scenario: The call tree of a Go main, through a handler handed to the router
    When I run "archdiff diagram calls:go/cmd/shop/main.go#main --depth 5 --format mermaid"
    Then "main" calls "NewRepo", "NewService" and "NewHandler"
    And a dashed line leads from "main" to "Handler.Place"
    And "Handler.Place" calls "Service.PlaceOrder", which calls "validate" and "Repo.Save"

  Scenario: A method written in another file than its type
    When I run "archdiff diagram calls:go/internal/orders/find.go#Service.FindOrder --format mermaid"
    Then "Service.FindOrder" calls "Service.lookup", which calls "Repo.Read"
    And "archdiff diagram classes:go" draws one box "Service" with "PlaceOrder", "FindOrder" and "lookup"

  Scenario: A Go test file covers what it imports
    When I run "archdiff diagram tests --format json"
    Then "go/internal/orders/orders.go" and "go/internal/store/store.go" are covered by 1 test file
    And "go/internal/orders/orders_test.go" is no subject of the picture

  Scenario: The logic of a Go method
    When I run "archdiff diagram logic:go/internal/orders/orders.go#Service.PlaceOrder"
    Then the rules table has "err != nil: yes | validate | return order, err"
    And the rules table has "err != nil: no | validate, s.repo.Save | return order, nil"
