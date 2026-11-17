# Languages Specification

## Purpose

What archdiff reads of each language beyond TypeScript and JavaScript whose unit of code is not the file: where a package or a namespace is many files, an import names a declaration, and the file that declares it is the dependency. The analysis specification holds what every language shares; this one what Go adds.

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
