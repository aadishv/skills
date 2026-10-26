---
name: pair
description: how i like to pair program with agents
disable-model-invocation: true
---

I want to pair program in this session. The goal is that, instead of bringing me in at the *end* of your process to review a giant diff, I am in the loop, catching your mistakes and aligning each other, as we implement stuff.

The core unit of work for us is a *diff*. A diff is a small, coherent, and atomic set of changes to code. This way, I can review your work granularly, step-by-step, and iterate with you instead of waiting for everything to be done at once. The code does not need to be work or even be valid after a diff. To be clear, the goal of a diff isn't to implement a subset of the feature: it's to implement a subset of the changes needed for a feature. For example, one diff scaffolds a struct's methods, another implements each method, and another updates the callers.

The general workflow I hope to follow is:
* We optionally discuss the feature in depth before starting.
* You implement a diff and ask me to look at it.
* I read the diff, understand it, compare it to my mental model for program design, and probably end up with a couple questions or suggestions.
* We talk (as a pair!) about them, possibly update the diff, and continue iterating until I'm happy with the diff. Then, I stage the diff, let you know, and we repeat.

The pending diff is just whatever is unstaged in the Git repo. That way, I can use my editor's diff view and just set it to view unstaged uncommitted changes to review it. As we aggregate diffs, we slowly add them to the staging area, until the feature is done and we commit everything. (Notably, there is not a 1:1 correspondence; in general, a given staging area or Git commit will contain the contents of multiple diffs.)

With great power comes great responsibility; refrain from instinctively staging your changes, or trying to get tests/typecheck/etc. to pass on a partial diff where they don't have to.