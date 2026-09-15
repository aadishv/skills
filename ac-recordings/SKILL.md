---
name: ac-recordings
description: Download the video and transcript of a Stanford OHS Adobe Connect class recording that is open in the user's browser, and answer questions about the lecture from the transcript (and video frames when needed).
disable-model-invocation: true
---

# Adobe Connect recordings

Requires the `codex-browser-use` skill to be set up (bridge running, extension paired) and `ffmpeg` on PATH. Read that skill first if you have not this session.

## 1. Pick the tab

List tabs and find the recording. Recording tabs have URLs like `https://pcadobeconnect.stanford.edu/<id>/?session=...`.

```bash
pnpm --dir ~/.agents/skills/codex-browser-use exec tsx ~/.agents/skills/ac-recordings/scripts/tabs.mts
```

If there is exactly one such tab, use it. If there are zero or more than one, stop and ask the user which tab they mean (or ask them to open the recording). Never guess.

## 2. Fetch

```bash
pnpm --dir ~/.agents/skills/codex-browser-use exec tsx ~/.agents/skills/ac-recordings/scripts/fetch.mts <targetId> [--video]
```

Prints JSON with `transcript` (Markdown path) and `video` (mp4 path or null). Files are cached under `$TMPDIR/ac-recordings/<id>/`; rerunning is cheap.

Pass `--video` only when the user asked for the video or you need frames. Recordings are 300 to 500 MB and take a while. The mp4 URL is signed with an expiry; if the download fails, ask the user to reload the tab and rerun.

Transcript-only fetches run in a second or two. Do that first for any question.

## 3. Answer questions

Read `transcript.md`. Each line is `[HH:MM:SS] Speaker: text`.

The transcript is machine generated and has errors ("pocks" for "dogs", mangled names, missing words). Silently use the corrected reading. Never mention the misspelling.

Be brief. Students want the answer, not an essay. Cite timestamps when pointing at a specific moment.

## 4. Look at the video

When a caption is ambiguous, the speaker refers to something on screen, or the user asks to see a moment, grab a frame and Read the image:

```bash
ffmpeg -loglevel error -y -ss HH:MM:SS -i "$VIDEO" -frames:v 1 /tmp/frame.png
```

Estimate the timestamp from the start of the speaker's turn plus where the phrase falls within it. Grab a few frames a few seconds apart if the first one misses.

To give the user the video itself, tell them the path printed by fetch, or copy it somewhere they asked for.
