// Usage: fetch.mts <targetId> [--video]
// Pulls the transcript (and optionally the mp4) from an open Adobe Connect
// recording tab into $TMPDIR/ac-recordings/<recording id>/.
import { connectBrowser } from "/Users/aadish/.agents/skills/codex-browser-use/sdk/index.ts";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [targetId, ...flags] = process.argv.slice(2);
if (!targetId) {
  console.error("usage: fetch.mts <targetId> [--video]");
  process.exit(1);
}
const wantVideo = flags.includes("--video");

const browser = await connectBrowser();
let info: { title: string; url: string; video: string; vtt: string };
try {
  const page = await browser.page(targetId);
  info = (await page.evaluate(`(() => {
    const v = document.querySelector("video");
    const t = v && v.querySelector("track");
    return {
      title: document.title,
      url: location.href,
      video: v ? v.currentSrc || v.src : "",
      vtt: t ? t.src : "",
    };
  })()`)) as typeof info;
  if (!info.video || !info.vtt) {
    console.error(`No <video>/<track> found on tab ${targetId} (${info.url}). Is this a recording page, and has it finished loading?`);
    process.exit(1);
  }
  const id = new URL(info.url).pathname.split("/").filter(Boolean)[0] ?? "recording";
  const dir = join(tmpdir(), "ac-recordings", id);
  mkdirSync(dir, { recursive: true });

  const vttPath = join(dir, "transcript.vtt");
  const mdPath = join(dir, "transcript.md");
  if (!existsSync(mdPath)) {
    // The VTT is behind the login cookie, so fetch it from inside the page.
    const vtt = (await page.evaluate(`fetch(${JSON.stringify(info.vtt)}).then(r => r.text())`)) as string;
    if (!vtt.startsWith("WEBVTT")) {
      console.error("Transcript fetch did not return WEBVTT; you may be logged out.");
      process.exit(1);
    }
    writeFileSync(vttPath, vtt);
    writeFileSync(mdPath, `# ${info.title}\n\n${vttToMarkdown(vtt)}`);
  }

  const videoPath = join(dir, "video.mp4");
  if (wantVideo && !existsSync(videoPath)) {
    // The mp4 URL carries its own signed token, so plain curl works.
    const r = spawnSync("curl", ["-fsSL", "-o", `${videoPath}.part`, info.video], { stdio: "inherit" });
    if (r.status !== 0) {
      console.error("video download failed (the signed URL may have expired; reload the tab and retry)");
      process.exit(1);
    }
    spawnSync("mv", [`${videoPath}.part`, videoPath]);
  }

  console.log(JSON.stringify({
    title: info.title,
    dir,
    transcript: mdPath,
    video: existsSync(videoPath) ? videoPath : null,
    videoBytes: existsSync(videoPath) ? statSync(videoPath).size : null,
  }, null, 2));
} finally {
  await browser.close();
}

function vttToMarkdown(vtt: string): string {
  const turns: { time: string; secs: number; speaker: string; text: string }[] = [];
  for (const block of vtt.split(/\n\n+/)) {
    const lines = block.trim().split("\n");
    const i = lines.findIndex((l) => l.includes("-->"));
    if (i < 0) continue;
    const time = lines[i].split("-->")[0].trim().split(".")[0];
    const secs = time.split(":").reduce((a, p) => a * 60 + Number(p), 0);
    const raw = lines.slice(i + 1).join(" ");
    // Cues look like "@:@Speaker Name@:@ text" and may contain several speakers.
    const parts = raw.split("@:@").map((s) => s.trim()).filter(Boolean);
    const cues = parts.length >= 2
      ? Array.from({ length: Math.floor(parts.length / 2) }, (_, k) => ({ speaker: parts[2 * k], text: parts[2 * k + 1] }))
      : [{ speaker: "", text: raw.trim() }];
    for (const c of cues) {
      const last = turns[turns.length - 1];
      // Merge same-speaker cues, but start a new line every ~90s so timestamps stay useful.
      if (last && last.speaker === c.speaker && secs - last.secs < 90) last.text += " " + c.text;
      else turns.push({ time, secs, ...c });
    }
  }
  return turns.map((t) => `[${t.time}] ${t.speaker || "Unknown"}: ${t.text}`).join("\n\n");
}
