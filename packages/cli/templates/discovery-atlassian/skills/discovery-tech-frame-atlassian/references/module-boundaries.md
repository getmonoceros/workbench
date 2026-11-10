# Module boundaries per language

The subject areas and their direction come from the domain model and do not
depend on the language. What differs is how much the language enforces by
itself, and so whether the project needs a check of its own.

The rows below are the usual ways, not a prescription. Which tool a project
uses is its own decision, and the place for it is the technical brief's
internal-structure convention (and an ADR in the repository once it changes).

| Language | An area is | A circle between areas | Typical check |
|---|---|---|---|
| Go | a package; `internal/` hides what others must not use | rejected by the compiler (import cycle) | the compiler; `internal/` for visibility |
| Rust | a crate in a workspace, or a module | rejected between crates, allowed between modules of one crate | one crate per area; `pub(crate)` for visibility |
| Java, Kotlin | a package or a build module | allowed between packages, rejected between build modules | an architecture test in the build, or one build module per area |
| TypeScript | a folder or a workspace package | allowed | a dependency lint rule in the build |
| Python | a package | allowed (and fails only at import time, if at all) | an import-contract check in the build |

**The rule that holds for every row:** where the language allows a circle, a
test or a lint rule checks the direction, and it runs in the acceptance
command, so a violation fails the build instead of waiting for a review.
