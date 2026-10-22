---
name: ac-recordings
description: Download the video and transcript of a Stanford OHS Adobe Connect class recording that is open in the user's browser, and answer questions about the lecture from the transcript (and video frames when needed).
disable-model-invocation: true
---

# Adobe Connect recordings

Requires the `browser-use` skill (bridge running, extension paired) and `ffmpeg` on PATH. Read that skill first if you have not this session.

`lib.ts` exports `isRecording(url)` and `fetchRecording(page)`. They take an attached SDK `Page` and never open their own connection, so call them from `execute_browser_code`.

## 1. Pick the tab and fetch

```ts
const { isRecording, fetchRecording } = await import("/Users/aadish/.agents/skills/ac-recordings/lib.ts")
const recs = (await tabs()).filter((t) => isRecording(t.url))
recs.length === 1 ? await fetchRecording(await page(recs[0].targetId)) : recs
```

Recording tabs have URLs like `https://pcadobeconnect.stanford.edu/<id>/?session=...`. If there is exactly one, use it. If there are zero or several, stop and ask the user which tab they mean (or ask them to open the recording). Never guess.

`fetchRecording` returns `{ title, dir, transcript, video, videoUrl }`. The transcript is cached under `$TMPDIR/ac-recordings/<id>/`, so rerunning is cheap. `video` is the local mp4 path if it was already downloaded, otherwise null.

Outside Pi, do the same from a script that gets the page from `connectBrowser()` and closes the browser in `finally`.

## 2. Video (only when needed)

Download the video only when the user asked for it or you need frames. Recordings are 300 to 500 MB, so run the download with bash (in tmux if it may exceed your timeout), not inside `execute_browser_code`:

```bash
curl -fsSL -o "$DIR/video.mp4.part" "$VIDEO_URL" && mv "$DIR/video.mp4.part" "$DIR/video.mp4"
```

`videoUrl` is signed with an expiry. If the download fails, ask the user to reload the tab, then call `fetchRecording` again for a fresh URL.

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

To give the user the video itself, tell them the `video.mp4` path, or copy it somewhere they asked for.
