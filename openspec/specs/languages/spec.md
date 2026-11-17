# Languages Specification

## Purpose

What archdiff reads of the languages whose unit of code is not the file: where a package or a namespace is many files, an import names a declaration, and the file that declares it is the dependency. The analysis specification holds what every language shares; this one what Go and Java add.

## Requirements

### Requirement: A Go package is its directory

The system SHALL read a Go import as the package it names and add no dependency for the import itself; every declaration a file uses of the package (`store.Save`, the type `store.Repo`) SHALL be a dependency on the file of that package that declares it, and a name a file uses without declaring or binding it SHALL be a dependency on the file of its own directory that declares it, or nothing when none does. The package of an import path SHALL be found through the `go.mod` files of the repository: the module path of the nearest `go.mod` above the importing file, of every other `go.mod` above a Go file, and of a `replace` to a directory, the longest that the path starts with, the rest of the path being a directory under it. A path of no module of the repository SHALL be the standard library when its first element has no dot (an external `go:<path>`), else a package: the module a `require` of the governing `go.mod` names, or the path's first three elements. A blank import SHALL depend on the package's first file; a dot import SHALL be noted as not followed. A declaration a package of the repository does not hold SHALL be listed as an unresolved import.

#### Scenario: A call into another package and another file

- **WHEN** `go/internal/orders/orders.go` of the polyglot fixture calls `validate(order)`, declared in `validate.go` beside it, and `s.repo.Save(order)` with `repo *store.Repo`
- **THEN** the module imports `validate.go` and `go/internal/store/store.go`, the calls resolve to `validate` and `Repo.Save`, and `go/cmd/shop/main.go`, which imports the package `orders`, has no line to `validate.go`

#### Scenario: The standard library and a required package

- **WHEN** a file imports `net/http` and `github.com/lib/pq`, and its `go.mod` requires `github.com/lib/pq`
- **THEN** its externals are `go:net/http` and `pkg:github.com/lib/pq`, and nothing is unresolved

### Requirement: Go declarations are functions, types and their methods

The system SHALL record a Go function as a function, a struct and every other defined type as a class with its named fields and their types as written (an embedded type as a field named as itself, the first as the base its methods come from), an interface as a type with its methods' signatures, an alias as a type naming what it stands for, and a method as a member of its receiver's type. A method written in another file of the package than its type SHALL be a member of a part of that type in its own file: a member SHALL be looked up in the type's declaration and in every part of it, and the class diagram SHALL draw the type once, with the methods of its parts. A capitalised name SHALL be exported; every top-level name SHALL be reachable from the other files of the package. An `init` function and the initializer of a package variable SHALL be the file's own code, run when it loads.

#### Scenario: A method in another file than its type

- **WHEN** `find.go` declares `func (s *Service) FindOrder(…)` and `orders.go` declares `type Service struct`
- **THEN** `calls:go/internal/orders/find.go#Service.FindOrder` follows `s.lookup(id)` to the method beside it, and `classes:go` draws one `Service` with `PlaceOrder`, `FindOrder` and `lookup`

### Requirement: Go calls follow the types the code writes

The system SHALL resolve a Go call of a function of the package or of an imported package, of a method on the receiver, and of a method of a value whose type the code writes: a parameter, a `var`, a composite literal (`Order{}`, `&Order{}`), `new(Order)`, a type assertion, a field of the receiver's struct declared in the same file, the first result of the call a local is made by (`repo := store.NewRepo()`, `repo, err := open()`), a package variable of the file or of another package. A function or a method handed to a call SHALL be a `ref` line of the caller. A conversion to a type of the language and a function literal called in place SHALL be no calls. A call through an interface no declaration says a type implements, through a type parameter, a function value, the variable of a `range` or of a type switch SHALL be a gap, with the reason the analysis specification gives its form.

#### Scenario: A handler handed to the router

- **WHEN** `main` runs `handler := httpapi.NewHandler(service)` and `http.HandleFunc("/orders", handler.Place)`
- **THEN** `calls:go/cmd/shop/main.go#main` has a call line to `NewHandler` and a dashed line to `Handler.Place`, whose own calls follow to `Service.PlaceOrder`, `validate` and `Repo.Save`

### Requirement: Go entry points, tests and control flow

The system SHALL treat a Go function named `main` as an entry point and a file named `*_test.go` as a test file; it SHALL count the branches of every Go function (`if`, `for`, a `switch`, a type switch and a `select` as one each), carry on every call the guards it sits under (an `else` by the condition it negates, a case by its value, its types or its channel operation), and draw `logic:<path>#<fn>` for it: the statement of an `if` before its condition as an action, a `switch` without a value named by its cases, no case running into the next, and `panic`, `log.Fatal` and `os.Exit` as exits.

#### Scenario: The flowchart of a Go method

- **WHEN** `archdiff diagram logic:go/internal/orders/orders.go#Service.PlaceOrder` runs on the polyglot fixture
- **THEN** the rules are `err != nil: yes` ending with `return order, err` after `validate`, and `err != nil: no` ending with `return order, nil` after `validate` and `s.repo.Save`

### Requirement: A Java import names a class

The system SHALL resolve a Java import to the file that declares the class of that qualified name among the analysed files (a nested class by its own qualified name), whatever directory holds it; a class of `src/test` or of another module declaring the same name SHALL yield to the one of the importing file's own source set. A class a file uses without importing it SHALL be looked for in the file's own package, then in each package it imports with `.*`, in that order, and SHALL be nothing missing when none declares it. A static import SHALL be a dependency on the class its member is of; an import of a package with `.*` SHALL add no dependency of its own. A name no file declares SHALL be the JDK's when its package starts with `java.`, `javax.` or `jdk.` (an external `java:<package>`), an unresolved import when a file of the repository declares that package, else a package named by the first three elements of its Java package.

#### Scenario: A class of the same package and of a wildcard import

- **WHEN** `OrderService.java` of the polyglot fixture runs `new Order(id, total)` with `Order` declared beside it and no import, and `MemoryOrders.java` imports `com.example.shop.orders.*` and names `Order`
- **THEN** both modules import `orders/Order.java`, and `archdiff analyze` reports 0 unresolved imports

### Requirement: Java declarations are types and their members

The system SHALL record a Java class, enum and record as a class with its fields and their types as written (a record's components and an enum's constants among them), its base and the interfaces it implements, and an interface and an annotation as a type with its methods' signatures and the interfaces it extends; a method as a member, a constructor as the member `constructor`, a type nested in another as a member of it — in scope by its own name in the file and imported by it — and a record's component as a method of the record too. An interface's method without a body SHALL be its shape only, so a call of it goes to the classes implementing the interface. `public` SHALL be exported, as an interface's member is. A field's initializer and an initializer block SHALL be the class's own code.

#### Scenario: A record and a nested class

- **WHEN** `OrderController.render` calls `order.id()` on the record `Order(String id, long total)`, and `OrderService.place` calls `Audit.record(order)` with `Audit` nested in `OrderService`
- **THEN** the calls resolve to `Order.id` and `OrderService.Audit.record`

### Requirement: Java calls follow the declared classes

The system SHALL resolve a Java call of a method written without a receiver to the class's own method, to that of a class around it, to the class a static import names, or — in a class that extends nothing, in a file with a static `.*` import — to that import's class; `this.m()`, `super.m()`, `super(…)` and `this(…)`; a method of a field, a parameter or a local by the class its declaration writes, of a `var` by what `new` or the call that made it gives, of a cast, of `new X()`, of a class named for a static method (a capitalised name nothing binds; one written with its package too), and of what a call returns. `new X(…)` SHALL be a call line to the class; a method reference among the arguments (`this::audit`, `Orders::first`) SHALL be a `ref` line. A method every class has from `Object` or `Enum` that the class and its bases do not declare SHALL be the language's (`external`), not a blind spot. A call through a lambda's parameter, a generic's element or an inherited field SHALL be a gap of a member of a value.

#### Scenario: A call through an interface

- **WHEN** `OrderService.place` calls `repository.save(order)` with `repository` declared as the interface `OrderRepository`, which `MemoryOrders` implements
- **THEN** `calls:…/App.java#App.main` reaches `MemoryOrders.save` through `OrderController.place` and `OrderService.place`

### Requirement: Java entry points, tests and control flow

The system SHALL treat the method `main` of a Java class as an entry point, a public method of a controller, handler, listener or the like that nothing calls as one, and a file under `src/test/` or named `*Test.java`, `*Tests.java` or `*IT.java` as a test file; it SHALL count the branches of every Java method (`if`, a loop, a `switch`, a `try` as one each), carry on every call its guards (a case by its label, a `catch` by what it catches), and draw `logic:<path>#<Class.method>` for it: a `case A:` group running into the next unless it leaves, a `case A ->` rule never, `synchronized (x)` as an action before its block, a `try` with resources as a `try`.

#### Scenario: A switch of groups and a switch of rules

- **WHEN** a method holds `switch (s) { case NEW: start(); case PAID: ship(); break; default: skip(); }` and `switch (s) { case NEW -> start(); case PAID -> { ship(); return 2; } }`
- **THEN** the first draws `NEW` into `start()` and on into `ship()`, `PAID` into `ship()` and `default` apart; the second one arrow per rule and `no match` carrying on
