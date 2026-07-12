---
name: walkthrough
description: Use to generate a structured walkthrough of a change.
---

## General instructions

Your goal is to produce a Markdown file that explains a change you made (the change will be specified by the user). The file you produce should be a regular Markdown file with two deviations from vanilla Markdown: use `git-diff` code blocks to render the diffs of certain hunks from the diff, and include the path+range of the change in the Markdown frontmatter of the file so the hunk resolver can find the diffs.

1. Run `git diff` on the provided range to get the relevant hunks.
2. Write the walkthrough to a Markdown file. Use the `git-diff` language to include hunks from specific files. Separate meaningful sections with headings. An example is below. **Use your best judgement here; the goal is to separate into meaningful atomic steps (as in the example) to make diff reviews more pleasant.** Do not take shortcuts, like just using one file per section; you have to individually inspect each hunk and use your judgement.
3. Ensure that you include all hunks from the diff.
4. The frontmatter should include the absolute path to the Git repository and the provided range.
5. The Markdown file path should be at ./.pi/walkthroughs/<id>.md, relative to your project directory. For example, the below guide could be at /Users/aadish/Developer/gh/amalgamation/.pi/walthroughs/amalgamator-interface-refactor.md.
6. Feel free to add more! This is an ordinary Markdown document, so add text, regular code blocks, images, etc., as needed to effectively explain the changes. For example, you can include an architecture diagram, or add a section about test coverage. Whatever makes sense given the context.
7. To show the user the file with diffs rendered, prefer using [cli.ts](./scripts) with upload enabled: `pnpm --dir path/to/scripts cli --upload path/to/some-walkthrough.md`. The CLI loads `BLOB_READ_WRITE_TOKEN` and `BLOB_STORE_ID` from `scripts/.env.local`, uploads the generated HTML to Vercel Blob at `shared/plan-MMDDYY-<uuid>.html`, deletes older uploaded plans from prior days, and prints the share link (`https://aadishv.dev/s/plan-MMDDYY-<uuid>`) on success. If upload can't run because those env vars aren't set, it falls back to printing the local HTML file path instead; in that case, show the user that path. If you need to display a local fallback file yourself, you can then call `open /path/to/file.html`.

## Example

---
directory: /Users/aadish/Developer/gh/amalgamation
range: 0abcdef..HEAD # or `staged`; for commits, just specify the commit ID, e.g., 0abcdef - no `..`
---

# Rewrite core interfaces

This refactor improves the interfaces by...

```git-diff
src/types.ts: *
src/index.ts:
    @@ -10,7 +10,9 @@
    @@ -67,3 +69,1 @@
```

# Update amalgamator to account for new interface

This update makes the amalgamator aware of the new interface changes...

```git-diff
src/amalgamator.ts:
    *
src/index.ts:
    @@ -100,56 +100,37 @@
```

# Verification

Ran tests:
```bash
pnpm test
```
5/5 passed. Also tested the web UI:
![web ui screenshot](/tmp/image.png)