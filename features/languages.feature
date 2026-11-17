Feature: The languages whose packages are many files
  archdiff reads Go and Java beside TypeScript, JavaScript, Python, Rust and PHP: an import names a package or a class, and the file that declares what is used is the dependency.
  The scenarios here are the ones tests/cli.test.ts and tests/extract.test.ts run on tests/fixtures/polyglot.

  Background:
    Given the polyglot repository with a Go module "example.com/shop" under go/
    And a Java package "com.example.shop" under java/src/main/java and java/src/test/java

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

  Scenario: A Java import names a class, wherever its file lies
    When I run "archdiff diagram dir:java --format mermaid"
    Then "orders/OrderService.java" imports "store/OrderRepository.java" by its import and "orders/Order.java" by its package
    And "store/MemoryOrders.java" imports "orders/Order.java" through "import com.example.shop.orders.*"
    And "archdiff coverage" reports 0 blind calls and 0 unresolved imports

  Scenario: The call tree of a Java main, through an interface
    When I run "archdiff diagram calls:java/src/main/java/com/example/shop/App.java#App.main --depth 4 --format mermaid"
    Then "App.main" calls "OrderController.place", which calls "OrderService.place"
    And "OrderService.place" calls "MemoryOrders.save", "OrderService.Audit.record" and "Order.valid"
    And "OrderController.render" calls "Order.id", the accessor of a record's component

  Scenario: A Java controller's method nothing calls is an entry point
    When I run "archdiff views"
    Then it lists "calls:java/src/main/java/com/example/shop/App.java#App.main" labelled "main"
    And it lists "calls:java/src/main/java/com/example/shop/web/OrderController.java#OrderController.show" labelled "uncalled method of a handler"

  Scenario: The logic of a Java method
    When I run "archdiff diagram logic:java/src/main/java/com/example/shop/web/OrderController.java#OrderController.place"
    Then the rules table has "try: ok | orders.place, render | return render(order)"
    And the rules table has "try: error IllegalArgumentException refused | refused.getMessage"
