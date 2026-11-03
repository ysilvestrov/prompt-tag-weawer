<!-- detent:constitution v1 begin — edit outside these markers; `npx -y @ysilvestrov/detent install` rewrites this block -->
## Development rules (detent)

Paths and commands named in backticks below (`specFile`, `specsDir`, …) are keys of `detent.json`
at the repository root; read their values there.

1. **The spec is the single source of truth.** Before changing behaviour, read `specFile`. If the
   change needs a new sentence in the spec, update the spec in the same PR. When code and spec
   disagree, the spec wins: the mismatch is a defect in the code, or a reason to change the spec
   through the full cycle. Design specs live in `<specsDir>/<YYYY-MM>/`.

2. **Classify after the probe, never on entry.** There are three paths: `spike` (commits
   nothing), the light path, and the full cycle. The light path is allowed only when all four
   conditions hold:
   (a) the fix restores behaviour the spec already describes and needs no new sentence in it;
   (b) the mechanism of the defect was proven by a live probe or a replay before classifying;
   (c) the change fits in two files plus their tests and introduces no new concept;
   (d) it does not change a rule that applies to all data.
   The trace of the light path is an issue plus a commit message that names the mechanism.

3. **The ratchet only goes one way.** The moment any light-path condition fails, stop. Record
   what you have (diagnosis, probe output, draft fix, measurements) as input, and start the
   change over through the full cycle. Never write a spec after the fact to fit a finished fix.
   Never reclassify downwards.

4. **Claim → evidence.** Every place where the system records something as fact gets a row in the
   spec's claim → evidence table. The format is in the `detent-design-spec` skill
   (`spec-format.md` next to its `SKILL.md`).

5. **Test quality.**
   - Exact assertions that pin the test's own fact, not the current state the next change will
     move. No weak assertions (truthy, defined, at-least) where an exact value is known.
   - A global value that grows with the code is pinned by exactly one test.
   - No conditional logic in tests: no branches, no early returns; one deterministic path.
   - No tautologies: do not compare a function with itself, do not check mock state instead of
     the code.
   - Cover boundaries, empty inputs and errors, not only the happy path.
   - Do not compute the expected value by repeating production logic in the test.

6. **The reviewer is not the author.** Before a PR, and before a spec goes to the owner, a model
   of another family reviews it through `npx -y @ysilvestrov/detent cross-review`. The protocol is
   in the `detent-cross-review` skill.

7. **Superpowers overrides** (apply only when Superpowers is installed). They name behaviour, not
   branch names inside those skills, because branch names change between releases. These
   overrides were checked against Superpowers 7.0.1 (brainstorming, writing-plans,
   subagent-driven-development, executing-plans, finishing-a-development-branch,
   using-git-worktrees, requesting-code-review); on a new Superpowers release, re-read them.
   - `superpowers:brainstorming`:
     - A "quick, clear task — just do it" or "small change — short doc" route does not bypass
       classification. A behaviour change without a spec is possible only on the light path (all
       four conditions, after the probe); everything else gets a full spec per
       `detent-design-spec`. A human opting out of questions cancels the questions, not the spec.
     - Sizing is the estimate game of `detent-design-spec`, not the author naming a size: the
       question that ends your first message is the owner's size (XS–XL), and yours comes only
       after an approach is picked.
     - Before the owner sees a spec: builder check, then `cross-review --spec`. The builder is of
       your family and is not the reviewer of rule 6; its questions only the owner can answer go
       into the spec's questions for the owner, not a separate round. More than three such
       questions means the spec is not ready: ask them in one message before the cross-review.
     - A spike commits nothing. Specs go to `<specsDir>/<YYYY-MM>/`, never flat.
   - `superpowers:writing-plans`: slice the plan per `detent-pr-slicing` and save it under
     `<plansDir>/<YYYY-MM>/`. Do not ask the owner to review the plan or pick an execution method:
     pick it per `detent-pr-slicing` and say which in one line.
   - `superpowers:subagent-driven-development`: do a small task inline (the conditions are in
     `detent-pr-slicing`) instead of dispatching it.
   - `superpowers:subagent-driven-development` and `superpowers:executing-plans`: the final
     review of a core plan is its end-to-end review: write the harness plan next, and finish the
     branch only after the last plan. A ruling that would change the spec's owner section stops
     the run: it is an amendment that returns the spec for approval. Never delete the plan's
     workspace; rule 8 applies.
   - `superpowers:finishing-a-development-branch`: do not ask for the base branch: rebase on
     `baseBranch`, run the gate, run `cross-review`, then open the PR by default, without asking,
     against the branch `baseBranch` names (without the remote). Only a human merges.

8. **Deletion.** Never type a recursive delete as a command (`rm -r…`, `Remove-Item -Recurse`,
   `find -delete`, `git clean`, `rmtree` and the like). Write a script file with literal absolute
   paths and guards (fail on unset variables, refuse paths outside the folder being cleaned),
   show the owner a dry run listing exactly what will go, and run it only after the owner says
   yes. Never in the background. Reason: an inline cleanup whose path variable expanded to empty
   once deleted far outside its folder.

Without Superpowers, start any behaviour change with `detent-dev-cycle`
<!-- detent:constitution end -->
