import { StrictMode, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { MultiFileDiff } from "@pierre/diffs/react";
import Content from "./.dist-mdx/content.mjs";
import { hasDiffs } from "./.dist-mdx/content-meta.mjs";

type DiffFile = { oldFile: { name: string; contents: string }; newFile: { name: string; contents: string } };
type DiffBlock = { files: DiffFile[] };
type Frontmatter = Record<string, unknown>;
const DIFF_STYLE_STORAGE_KEY = "diff-walkthrough:diff-style";

const css = `
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: "SF Pro", -apple-system, BlinkMacSystemFont, sans-serif; background: var(--page); color: var(--text); }
  button { font: inherit; }
  .walkthrough { --page: #fff; --text: #0f172a; --muted: #475569; --heading: #0f172a; --border: #cbd5e1; --button: #f8fafc; --active: #e2e8f0; min-height: 100vh; padding: 24px 40px 64px; background: var(--page); color: var(--text); }
  .walkthrough.dark { --page: #000; --text: #e2e8f0; --muted: #94a3b8; --heading: #f8fafc; --border: #334155; --button: #000; --active: #111827; }
  .toolbar { display: flex; gap: 12px; align-items: center; margin-bottom: 20px; }
  .toolbar button { border: 1px solid var(--border); background: var(--button); color: var(--text); border-radius: 8px; padding: 6px 10px; cursor: pointer; }
  .diff-style { display: inline-flex; overflow: hidden; border: 1px solid var(--border); border-radius: 8px; }
  .diff-style button { border: 0; border-radius: 0; text-transform: capitalize; }
  .diff-style button + button { border-left: 1px solid var(--border); }
  .toolbar .active { background: var(--active); }
  .markdown-content h1 { margin: 40px 0 16px; color: var(--heading); font-size: 36px; font-weight: 500; line-height: 1.2; }
  .markdown-content h2 { margin: 32px 0 12px; color: var(--heading); font-size: 24px; font-weight: 600; line-height: 1.3; }
  .markdown-content p { margin: 0 0 18px; color: var(--text); font-size: 18px; line-height: 1.75; }
  .markdown-content ul, .markdown-content ol { margin: 0 0 20px; padding-left: 28px; line-height: 1.75; }
  .markdown-content li { margin: 6px 0; font-size: 18px; }
  .frontmatter { margin-bottom: 24px; }
  .frontmatter table { width: 100%; margin: 0; border: 0; font-family: "SF Mono", Monaco, Inconsolata, "Roboto Mono", monospace; font-size: 13px; line-height: 1.5; }
  .frontmatter td { border: 0; padding: 6px 0; vertical-align: top; }
  .frontmatter td:first-child { padding-right: 12px; color: var(--muted); white-space: nowrap; }
  .frontmatter td:last-child { color: var(--text); word-break: break-word; }
  .markdown-content :not(pre) > code { padding: .1em .3em; border: 1px solid var(--border); border-radius: 5px; font-family: SFMono-Regular, Consolas, monospace; font-size: .82em; }
  .code-block { margin: 20px 0; overflow-x: auto; border: 1px solid var(--border); border-radius: 12px; }
  .code-block pre.shiki { margin: 0; padding: 18px 20px; background: transparent !important; }
  .code-block pre.shiki code { display: block; font-family: SFMono-Regular, Consolas, monospace; font-size: 16px; line-height: 1.6; white-space: pre; }
  .code-block .shiki, .code-block .shiki span { background-color: transparent !important; }
  .walkthrough.dark .code-block .shiki, .walkthrough.dark .code-block .shiki span { color: var(--shiki-dark) !important; }
  .diff-file { content-visibility: auto; contain-intrinsic-size: auto 320px; }
`;

function GitDiff({ blockIndex, mode, diffStyle }: { blockIndex: number; mode: "light" | "dark"; diffStyle: "unified" | "split" }) {
  const block = useMemo(() => {
    const data = document.getElementById(`walkthrough-diff-${blockIndex}`)?.textContent;
    if (!data) throw new Error(`Missing data for diff block ${blockIndex}.`);
    return JSON.parse(data) as DiffBlock;
  }, [blockIndex]);
  const storageKey = `diff-walkthrough:viewed:${window.location.pathname}:${blockIndex}`;
  const [viewed, setViewed] = useState<Record<number, boolean>>(() => { try { return JSON.parse(localStorage.getItem(storageKey) ?? "{}"); } catch { return {}; } });
  useEffect(() => { try { localStorage.setItem(storageKey, JSON.stringify(viewed)); } catch {} }, [storageKey, viewed]);
  return <section style={{ margin: "24px 0" }}>{block.files.map((file, index) => <div className="diff-file" key={`${file.newFile.name}-${index}`} style={{ marginBottom: 20 }}><MultiFileDiff oldFile={file.oldFile} newFile={file.newFile} renderHeaderMetadata={() => <label style={{ display: "inline-flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: 14 }}><input type="checkbox" checked={viewed[index] ?? false} onChange={(event) => setViewed((state) => ({ ...state, [index]: event.target.checked }))} />Viewed</label>} options={{ collapsed: viewed[index] ?? false, theme: { dark: mode === "dark" ? "pierre-dark" : "pierre-light", light: mode === "dark" ? "pierre-dark" : "pierre-light" }, diffStyle, overflow: "wrap", expansionLineCount: 20 }} /></div>)}</section>;
}

function value(item: unknown) { return typeof item === "object" && item !== null ? JSON.stringify(item) : String(item); }
function FrontmatterCard({ data, summary }: { data: Frontmatter; summary: { fileCount: number; additions: number; deletions: number } }) {
  const entries = Object.entries(data);
  if (summary.fileCount) entries.push(["diff", summary]);
  return <section className="frontmatter"><table><tbody>{entries.map(([key, item]) => <tr key={key}><td>{key}</td><td>{key === "diff" && typeof item === "object" && item !== null ? <>{summary.fileCount} file{summary.fileCount === 1 ? "" : "s"} changed / <span style={{ color: "#16a34a" }}>+{summary.additions}</span> <span style={{ color: "#dc2626" }}>-{summary.deletions}</span></> : value(item)}</td></tr>)}</tbody></table></section>;
}

function App() {
  const [mode, setMode] = useState<"light" | "dark">("light");
  const [diffStyle, setDiffStyle] = useState<"unified" | "split">(() => localStorage.getItem(DIFF_STYLE_STORAGE_KEY) === "split" ? "split" : "unified");
  useEffect(() => { localStorage.setItem(DIFF_STYLE_STORAGE_KEY, diffStyle); }, [diffStyle]);
  const components = { GitDiff: (props: { blockIndex: number }) => <GitDiff {...props} mode={mode} diffStyle={diffStyle} />, FrontmatterCard };
  return <main className={`walkthrough ${mode === "dark" ? "dark" : ""}`}><style>{css}</style><div className="toolbar">{hasDiffs ? <div className="diff-style">{(["unified", "split"] as const).map((style) => <button className={diffStyle === style ? "active" : ""} key={style} onClick={() => setDiffStyle(style)}>{style}</button>)}</div> : null}<button style={{ marginLeft: "auto" }} onClick={() => setMode(mode === "dark" ? "light" : "dark")}>{mode === "dark" ? "Dark" : "Light"}</button></div><article className="markdown-content"><Content components={components} /></article></main>;
}

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
