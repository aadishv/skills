// Helpers for Adobe Connect recording tabs. They take an attached browser-use `Page` and never open
// their own connection, so they work from execute_browser_code or from a standalone script.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Page = { evaluate(expression: string): Promise<unknown> };

export function isRecording(url: string): boolean {
  return /adobeconnect\.[^/]+\/[^/]+\/\?session=/.test(url);
}

/** Saves the transcript under $TMPDIR/ac-recordings/<id>/ and returns the paths plus the signed mp4 URL. */
export async function fetchRecording(page: Page) {
  const info = (await page.evaluate(`(() => {
    const v = document.querySelector("video");
    const t = v && v.querySelector("track");
    return {
      title: document.title,
      url: location.href,
      video: v ? v.currentSrc || v.src : "",
      vtt: t ? t.src : "",
    };
  })()`)) as { title: string; url: string; video: string; vtt: string };
  if (!info.video || !info.vtt) {
    throw new Error(`No <video>/<track> on ${info.url}. Is this a recording page, and has it finished loading?`);
  }

  const id = new URL(info.url).pathname.split("/").filter(Boolean)[0] ?? "recording";
  const dir = join(tmpdir(), "ac-recordings", id);
  mkdirSync(dir, { recursive: true });

  const transcript = join(dir, "transcript.md");
  if (!existsSync(transcript)) {
    // The VTT is behind the login cookie, so fetch it from inside the page.
    const vtt = (await page.evaluate(`fetch(${JSON.stringify(info.vtt)}).then(r => r.text())`)) as string;
    if (!vtt.startsWith("WEBVTT")) throw new Error("Transcript fetch did not return WEBVTT; the user may be logged out.");
    writeFileSync(join(dir, "transcript.vtt"), vtt);
    writeFileSync(transcript, `# ${info.title}\n\n${vttToMarkdown(vtt)}`);
  }

  const video = join(dir, "video.mp4");
  return {
    title: info.title,
    dir,
    transcript,
    video: existsSync(video) ? video : null,
    videoUrl: info.video,
  };
}

export function vttToMarkdown(vtt: string): string {
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
