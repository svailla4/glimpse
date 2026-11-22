---
description: Review a branch, a pull request or the working tree as a Glimpse page
argument-hint: [a git range, a pull request number, or nothing]
---

Use the `glimpse` skill and read its `references/review.md` before writing the spec.

Review a change: $ARGUMENTS

With nothing given, review the working tree when it has changes, else the current branch against the default branch. For a pull request number, read it with `gh pr view` and review its range.

Read the code it concerns first. Draw the page in Glimpse with `show`, run the reader check from the skill and patch what it finds. Then tell me in a few lines what the page shows and what it asks of me.
