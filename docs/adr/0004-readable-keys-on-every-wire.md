# Views and declarations are named by readable keys everywhere

A view is named by a readable key (`module:src/lib/orders.ts`, `calls:src/lib/orders.ts#placeOrder`, `layers`) and a declaration by its module and name (`src/lib/orders.ts#OrderService.place`) on every wire: the page's link, a chat tag, a drawing's file name and its shapes' IDs, the Markdown, the exports' element IDs, the CLI's arguments. A key stays the same across runs, branches and machines, so a link in a pull request opens the same picture and a drawing finds its shapes after the code moved; in the code between the wires, keys are read and written by one codec (view-keys.ts) and never by hand.

## Considered options

- Opaque IDs (a hash or a counter) with a lookup table: no parsing and no collisions, but links and drawings that break with every run, and IDs a reader cannot read in a review.

The cost is parsing at the edges, and a rule a key cannot escape: the first `#` of a key ends the module's path, so a file whose name holds a `#` cannot be named.
