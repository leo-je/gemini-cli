# `ui/fix/` — fork-owned modules

This directory holds **this fork's** changes that would otherwise be inlined
into upstream files. It exists to keep `git merge` against `upstream/main`
cheap.

## Why a separate directory

Upstream files (`sessionUtils.ts`, `MainContent.tsx`, …) are edited by upstream
constantly. Every fork-owned line inside them is a line that can conflict, and a
conflict there forces someone to reason about upstream code before they can
merge. Moving the logic into files that upstream does not have reduces the
fork's footprint in an upstream file to an import plus one call.

When a conflict does happen, it lands in one of these files, which is ours:
resolve it here.

## Conventions

1. **One concern per file**, named `<upstream concept>-<fork concern>.ts`.
2. **A header comment** stating that the file is fork-owned and that it is the
   fork's copy, so a future merge keeps it rather than deleting it.
3. **Call sites are marked** with a short `Fork change:` comment naming the
   module to adapt, so nobody re-inlines the logic.
4. **Every file is covered by unit tests** next to it. That is what makes the
   behaviour portable if upstream reshapes the surrounding code.
5. Prefer **plain exported functions**. A hook in this directory would widen the
   diff at the call site more than a function that takes its settings as an
   argument does.

## Contents

| File                       | Concern                                                                                                                                                                               |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `thinkingFragments.ts`     | `convertSessionToHistoryFormats` emitted one UI item per recorded _thinking fragment_, which exploded resumed long sessions. This collapses a message's fragments into a single item. |
| `historyItemVisibility.ts` | `MainContent` mounted Ink nodes for history items that render nothing at all. This drops them before they reach the tree.                                                             |
