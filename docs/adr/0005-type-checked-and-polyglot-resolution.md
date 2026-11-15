# 5. Type-checked JS/TS resolution and tree-sitter for Python, Go and Java

Status: accepted

## Context

The dependency graph resolved relative JS/TS imports and calls by bare identifier only. Path aliases, workspace packages, `obj.method()` calls, callbacks and interface dispatch were invisible, which is most of how real TypeScript code connects, and other languages had no function-level analysis at all.

## Decision

- **JS/TS:** build a TypeScript `Program` over the repository's files in memory (no `node_modules`, no lib files) with the repository's own `paths` / `baseUrl`, plus a resolver that maps workspace package names to their source entry. The type checker resolves each call's symbol to its declaration, follows aliases, links functions passed as arguments, and links interface or base-class members to every implementation (labeled as possible dispatch). If the program cannot be built, the previous syntactic resolver is used.
- **Python, Go, Java:** official tree-sitter grammars, loaded as WebAssembly (no native build). Per-language resolvers handle module and package imports (`go.mod` module paths, Java packages and same-package visibility, Python relative imports), `self`/`this` and receiver methods, and constructors. A call on an untyped instance is linked only when the method name is unique among visible code, and the edge says so.
- The graph is rebuilt per commit on demand, so the impact map reflects the code as it was at the commit being examined.

## Consequences

- Real repositories go from a handful of edges to hundreds: in testing, ky (TypeScript) gave 177 type-checked call edges, requests (Python) 547, and cobra (Go) 1,435.
- The type checker without lib files cannot see into packages outside the repository or through `any`; those calls stay unlinked rather than guessed.
- Name-match edges in Python, Go and Java can be wrong when two unrelated classes share a method name and only one is visible; they are labeled so reviewers can discount them.
