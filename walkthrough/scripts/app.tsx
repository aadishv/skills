import { Profiler, StrictMode, isValidElement, useEffect, useMemo, useRef, useState, type ComponentPropsWithoutRef, type ProfilerOnRenderCallback, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { MultiFileDiff } from "@pierre/diffs/react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { codeToHtml, type BundledLanguage } from "shiki";
import { load } from "js-yaml";
import { structuredPatch } from "diff";
import type { ResolvedDiffBlock } from "./resolve-git-diffs";
import type { GitDiffBlockSource } from "./extract-git-diff-blocks";

type CodeProps = {
    className?: string;
    children?: ReactNode;
};

type ParagraphProps = ComponentPropsWithoutRef<"p"> & {
    children?: ReactNode;
};

type InitialData = {
    markdown: string;
    gitDiffBlocks: GitDiffBlockSource[];
    resolvedBlocks: ResolvedDiffBlock[];
};

type FrontmatterValue = string | number | boolean | null | FrontmatterValue[] | {
    [key: string]: FrontmatterValue;
};

type FrontmatterData = Record<string, FrontmatterValue>;

declare global {
    interface Window {
        __GLIMPSE_INITIAL_DATA__?: InitialData;
    }
}

const INITIAL_DATA_SCRIPT_ID = "glimpse-initial-data";
const INITIAL_DATA_META_NAME = "glimpse-initial-data";
const DIFF_BLOCK_PLACEHOLDER_PREFIX = "PI-DIFF-BLOCK-";
const DIFF_BLOCK_PLACEHOLDER_SUFFIX = "-PLACEHOLDER";
const APP_BOOTSTRAP_LABEL = "[diff-walkthrough] bootstrap-to-first-paint";
const MODULE_START_TIME = performance.now();
const DIFF_STYLE_STORAGE_KEY = "diff-walkthrough:diff-style";

console.time(APP_BOOTSTRAP_LABEL);

function profileSync<T>(label: string, fn: () => T): T {
    const start = performance.now();
    try {
        return fn();
    } finally {
        console.log(`${label}: ${(performance.now() - start).toFixed(1)}ms`);
    }
}

const logReactProfiler: ProfilerOnRenderCallback = (
    id,
    phase,
    actualDuration,
    baseDuration,
    startTime,
    commitTime,
) => {
    console.log(
        `[diff-walkthrough] ${id} ${phase}`,
        {
            actualDuration: `${actualDuration.toFixed(1)}ms`,
            baseDuration: `${baseDuration.toFixed(1)}ms`,
            startTime: `${(startTime - MODULE_START_TIME).toFixed(1)}ms`,
            commitTime: `${(commitTime - MODULE_START_TIME).toFixed(1)}ms`,
        },
    );
};

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

function isInitialData(value: unknown): value is InitialData {
    return (
        isRecord(value)
        && typeof value.markdown === "string"
        && Array.isArray(value.gitDiffBlocks)
        && Array.isArray(value.resolvedBlocks)
    );
}

function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function readEmbeddedInitialData(): InitialData | null {
    if (window.__GLIMPSE_INITIAL_DATA__) {
        console.log("[diff-walkthrough] using window.__GLIMPSE_INITIAL_DATA__");
        return window.__GLIMPSE_INITIAL_DATA__;
    }

    const element = document.getElementById(INITIAL_DATA_SCRIPT_ID);
    if (!element?.textContent) {
        console.log("[diff-walkthrough] no embedded initial data found");
        return null;
    }

    try {
        return profileSync("[diff-walkthrough] parse embedded initial data", () => {
            const parsed: unknown = JSON.parse(element.textContent ?? "null");
            return isInitialData(parsed) ? parsed : null;
        });
    } catch {
        return null;
    }
}

async function fetchInitialData(): Promise<InitialData> {
    const dataPath = document
        .querySelector<HTMLMetaElement>(`meta[name="${INITIAL_DATA_META_NAME}"]`)
        ?.getAttribute("content");

    if (!dataPath) {
        throw new Error("Missing initial data path.");
    }

    const label = `[diff-walkthrough] fetch initial data (${dataPath})`;
    console.time(label);

    try {
        const response = await fetch(dataPath);
        if (!response.ok) {
            throw new Error(`Failed to load initial data (${response.status}).`);
        }

        const parsed: unknown = await response.json();
        if (!isInitialData(parsed)) {
            throw new Error("Invalid initial data payload.");
        }

        return parsed;
    } finally {
        console.timeEnd(label);
    }
}

function replaceGitDiffBlocksWithPlaceholders(markdown: string): string {
    let index = 0;
    return markdown.replace(/```git-diff[^\n]*\n[\s\S]*?\n```/g, () => {
        const placeholder = `${DIFF_BLOCK_PLACEHOLDER_PREFIX}${index}${DIFF_BLOCK_PLACEHOLDER_SUFFIX}`;
        index += 1;
        return `\n\n${placeholder}\n\n`;
    });
}

function getPlainText(node: ReactNode): string {
    if (typeof node === "string" || typeof node === "number") {
        return String(node);
    }

    if (Array.isArray(node)) {
        return node.map(getPlainText).join("");
    }

    if (isValidElement<{ children?: ReactNode }>(node)) {
        return getPlainText(node.props.children);
    }

    return "";
}

function getDiffBlockIndex(children: ReactNode): number | null {
    const text = getPlainText(children).trim();
    const escapedPrefix = DIFF_BLOCK_PLACEHOLDER_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const escapedSuffix = DIFF_BLOCK_PLACEHOLDER_SUFFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = text.match(new RegExp(`^${escapedPrefix}(\\d+)${escapedSuffix}$`));
    return match ? Number(match[1]) : null;
}

function ShikiCodeBlock({
    children,
    className,
    mode,
}: CodeProps & { mode: "light" | "dark" }) {
    const code = getPlainText(children).replace(/\n$/, "");
    const language = className?.match(/(?:^|\s)language-([^\s]+)/)?.[1] ?? "text";
    const [highlightedHtml, setHighlightedHtml] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        setHighlightedHtml(null);

        void codeToHtml(code, {
            lang: language as BundledLanguage,
            theme: mode === "dark" ? "github-dark" : "github-light",
            structure: "inline",
        })
            .then((html) => {
                if (!cancelled) setHighlightedHtml(html);
            })
            .catch(() => {
                // Keep the readable plain-text fallback for unknown languages.
            });

        return () => {
            cancelled = true;
        };
    }, [code, language, mode]);

    const codeStyle = {
        display: "block",
        fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace',
        fontSize: 16,
        lineHeight: 1.6,
        color: mode === "dark" ? "#e6edf3" : "#24292f",
        whiteSpace: "pre" as const,
    };

    return (
        <pre
            style={{
                margin: "20px 0",
                padding: "18px 20px",
                borderRadius: 12,
                overflowX: "auto",
                border: `1px solid ${mode === "dark" ? "#30363d" : "#d0d7de"}`,
            }}
        >
            {highlightedHtml === null
                ? <code style={codeStyle}>{code}</code>
                : <code style={codeStyle} dangerouslySetInnerHTML={{ __html: highlightedHtml }} />}
        </pre>
    );
}

function GitDiffBlock({
    block,
    mode,
    blockIndex,
    diffStyle,
    storageKey,
}: {
    block: ResolvedDiffBlock | undefined;
    mode: "light" | "dark";
    blockIndex: number;
    diffStyle: "unified" | "split";
    storageKey: string;
}) {
    const [viewedFiles, setViewedFiles] = useState<Record<number, boolean>>(() => {
        try {
            const stored = window.localStorage.getItem(storageKey);
            if (!stored) return {};
            const parsed: unknown = JSON.parse(stored);
            return isRecord(parsed)
                ? Object.fromEntries(
                    Object.entries(parsed).filter((entry): entry is [string, boolean] => typeof entry[1] === "boolean"),
                )
                : {};
        } catch {
            return {};
        }
    });

    useEffect(() => {
        try {
            window.localStorage.setItem(storageKey, JSON.stringify(viewedFiles));
        } catch {
            // noop
        }
    }, [storageKey, viewedFiles]);

    if (!block) return <p>Loading diff…</p>;

    return (
        <section style={{ margin: "24px 0" }}>
            <Profiler id={`GitDiffBlock#${blockIndex}`} onRender={logReactProfiler}>
                {block.files.map((file, index) => {
                    const viewed = viewedFiles[index] ?? false;

                    return (
                        <div key={`${file.newFile.name}-${index}`} style={{ marginBottom: 20 }}>
                            <MultiFileDiff
                                oldFile={file.oldFile}
                                newFile={file.newFile}
                                renderHeaderMetadata={() => (
                                    <label
                                        style={{
                                            display: "inline-flex",
                                            alignItems: "center",
                                            gap: 8,
                                            cursor: "pointer",
                                            fontSize: 14,
                                        }}
                                    >
                                        <input
                                            type="checkbox"
                                            checked={viewed}
                                            onChange={(event) => {
                                                const nextViewed = event.target.checked;
                                                setViewedFiles((current) => ({
                                                    ...current,
                                                    [index]: nextViewed,
                                                }));
                                            }}
                                        />
                                        Viewed
                                    </label>
                                )}
                                options={{
                                    collapsed: viewed,
                                    theme: {
                                        dark: mode === "dark" ? "pierre-dark" : "pierre-light",
                                        light: mode === "dark" ? "pierre-dark" : "pierre-light",
                                    },
                                    diffStyle,
                                    overflow: "wrap",
                                    expansionLineCount: 20,
                                }}
                            />
                        </div>
                    );
                })}
            </Profiler>
        </section>
    );
}

function parseFrontmatter(markdown: string): {
    body: string;
    frontmatter: FrontmatterData | null;
} {
    const match = markdown.match(/^---\n([\s\S]*?)\n---\n?/);
    if (!match) {
        return { body: markdown, frontmatter: null };
    }

    try {
        const parsed = load(match[1]);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            return {
                body: markdown.slice(match[0].length),
                frontmatter: null,
            };
        }

        return {
            body: markdown.slice(match[0].length),
            frontmatter: parsed as FrontmatterData,
        };
    } catch {
        return { body: markdown, frontmatter: null };
    }
}

function formatFrontmatterValue(value: FrontmatterValue): string {
    if (Array.isArray(value)) {
        return value.map(formatFrontmatterValue).join(", ");
    }

    if (value && typeof value === "object") {
        return JSON.stringify(value);
    }

    if (value === null) {
        return "null";
    }

    return String(value);
}

function getWalkthroughDiffSummary(resolvedBlocks: ResolvedDiffBlock[]) {
    const filePaths = new Set<string>();
    let additions = 0;
    let deletions = 0;

    for (const block of resolvedBlocks) {
        for (const file of block.files) {
            filePaths.add(file.newFile.name || file.oldFile.name);

            const patch = structuredPatch(
                file.oldFile.name || "/dev/null",
                file.newFile.name || "/dev/null",
                file.oldFile.contents,
                file.newFile.contents,
                "",
                "",
                { context: Number.MAX_SAFE_INTEGER },
            );

            for (const hunk of patch.hunks) {
                for (const line of hunk.lines) {
                    if (line.startsWith("+") && !line.startsWith("+++")) additions += 1;
                    if (line.startsWith("-") && !line.startsWith("---")) deletions += 1;
                }
            }
        }
    }

    return {
        fileCount: filePaths.size,
        additions,
        deletions,
    };
}

function FrontmatterCard({
    frontmatter,
    summary,
    mode,
}: {
    frontmatter: FrontmatterData;
    summary: { fileCount: number; additions: number; deletions: number } | null;
    mode: "light" | "dark";
}) {
    const entries = [...Object.entries(frontmatter)];
    if (summary !== null) entries.push(["diff", summary] as const);

    return (
        <section style={{ marginBottom: 24 }}>
            <table
                style={{
                    width: "100%",
                    borderCollapse: "collapse",
                    fontFamily:
                        '"SF Mono", "Monaco", "Inconsolata", "Roboto Mono", monospace',
                    fontSize: 13,
                    lineHeight: 1.5,
                }}
            >
                <tbody>
                    {entries.map(([key, value]) => (
                        <tr key={key}>
                            <td
                                style={{
                                    padding: "6px 12px 6px 0",
                                    verticalAlign: "top",
                                    whiteSpace: "nowrap",
                                    color: mode === "dark" ? "#94a3b8" : "#475569",
                                }}
                            >
                                {key}
                            </td>
                            <td
                                style={{
                                    padding: "6px 0",
                                    verticalAlign: "top",
                                    color: mode === "dark" ? "#e2e8f0" : "#0f172a",
                                    wordBreak: "break-word",
                                }}
                            >
                                {typeof value === "string"
                                    ? value
                                    : key === "diff"
                                      ? (
                                            <>
                                                {value.fileCount} file{value.fileCount === 1 ? "" : "s"} changed / {" "}
                                                <span style={{ color: mode === "dark" ? "#4ade80" : "#16a34a" }}>
                                                    +{value.additions}
                                                </span>{" "}
                                                <span style={{ color: mode === "dark" ? "#f87171" : "#dc2626" }}>
                                                    -{value.deletions}
                                                </span>
                                            </>
                                        )
                                      : formatFrontmatterValue(value)}
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </section>
    );
}

function MarkdownView({
    markdown,
    resolvedBlocks,
    mode,
    diffStyle,
}: {
    markdown: string;
    resolvedBlocks: ResolvedDiffBlock[];
    mode: "light" | "dark";
    diffStyle: "unified" | "split";
}) {
    const { frontmatter, renderedBody, diffSummary } = useMemo(
        () => profileSync("[diff-walkthrough] markdown preprocessing", () => {
            const { body, frontmatter } = parseFrontmatter(markdown);
            return {
                body,
                frontmatter,
                renderedBody: replaceGitDiffBlocksWithPlaceholders(body),
                diffSummary: getWalkthroughDiffSummary(resolvedBlocks),
            };
        }),
        [markdown, resolvedBlocks],
    );

    return (
        <>
            {frontmatter ? <FrontmatterCard frontmatter={frontmatter} summary={diffSummary.fileCount > 0 ? diffSummary : null} mode={mode} /> : null}
            <Profiler id="MarkdownView" onRender={logReactProfiler}>
                <ReactMarkdown
                remarkPlugins={[remarkGfm, remarkMath]}
                rehypePlugins={[rehypeKatex]}
                components={{
                    h1({ node: _node, ...props }) {
                        return (
                            <h1
                                style={{
                                    fontWeight: 500,
                                    fontSize: 36,
                                    lineHeight: 1.2,
                                    margin: "40px 0 16px",
                                    color: mode === "dark" ? "#f8fafc" : "#0f172a",
                                }}
                                {...props}
                            />
                        );
                    },
                    h2({ node: _node, ...props }) {
                        return (
                            <h2
                                style={{
                                    fontWeight: 600,
                                    fontSize: 24,
                                    lineHeight: 1.3,
                                    margin: "32px 0 12px",
                                    color: mode === "dark" ? "#f8fafc" : "#0f172a",
                                }}
                                {...props}
                            />
                        );
                    },
                    p({ node: _node, ...props }: ParagraphProps & { node?: unknown }) {
                        const blockIndex = getDiffBlockIndex(props.children);
                        if (blockIndex !== null) {
                            return (
                                <GitDiffBlock
                                    block={resolvedBlocks[blockIndex]}
                                    mode={mode}
                                    blockIndex={blockIndex}
                                    diffStyle={diffStyle}
                                    storageKey={`diff-walkthrough:viewed:${window.location.pathname}:${blockIndex}`}
                                />
                            );
                        }

                        return (
                            <p
                                style={{
                                    margin: "0 0 18px",
                                    fontSize: 18,
                                    lineHeight: 1.75,
                                    color: mode === "dark" ? "#e2e8f0" : "#0f172a",
                                }}
                                {...props}
                            />
                        );
                    },
                    ul({ node: _node, ...props }) {
                        return <ul style={{ margin: "0 0 20px", paddingLeft: 28, lineHeight: 1.75 }} {...props} />;
                    },
                    ol({ node: _node, ...props }) {
                        return <ol style={{ margin: "0 0 20px", paddingLeft: 28, lineHeight: 1.75 }} {...props} />;
                    },
                    li({ node: _node, ...props }) {
                        return <li style={{ margin: "6px 0", fontSize: 18 }} {...props} />;
                    },
                    pre({ node: _node, children }) {
                        if (isValidElement<CodeProps>(children)) {
                            return (
                                <ShikiCodeBlock
                                    className={children.props.className}
                                    mode={mode}
                                >
                                    {children.props.children}
                                </ShikiCodeBlock>
                            );
                        }

                        return <pre>{children}</pre>;
                    },
                    code({ className, children }: CodeProps) {
                        return (
                            <code
                                className={className}
                                style={{
                                    fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace',
                                    fontSize: "0.82em",
                                    lineHeight: 1.35,
                                    padding: "0.1em 0.3em",
                                    borderRadius: 5,
                                    border: `1px solid ${mode === "dark" ? "#30363d" : "#d8dee4"}`,
                                }}
                            >
                                {children}
                            </code>
                        );
                    },
                }}
                >
                    {renderedBody}
                </ReactMarkdown>
            </Profiler>
        </>
    );
}

function App() {
    const [data, setData] = useState<InitialData | null>(() => readEmbeddedInitialData());
    const [loadError, setLoadError] = useState<string | null>(null);
    const [mode, setMode] = useState<"light" | "dark">("light");
    const [diffStyle, setDiffStyle] = useState<"unified" | "split">(() => {
        try {
            const stored = window.localStorage.getItem(DIFF_STYLE_STORAGE_KEY);
            return stored === "split" ? "split" : "unified";
        } catch {
            return "unified";
        }
    });
    const hasDiffs = useMemo(() => {
        return (data?.resolvedBlocks.length ?? 0) > 0;
    }, [data]);
    const hasLoggedFirstPaint = useRef(false);

    useEffect(() => {
        const background = mode === "dark" ? "#000000" : "#ffffff";
        document.documentElement.style.margin = "0";
        document.documentElement.style.background = background;
        document.body.style.margin = "0";
        document.body.style.background = background;
        const root = document.getElementById("root");
        if (root) {
            root.style.minHeight = "100vh";
            root.style.background = background;
        }
    }, [mode]);

    useEffect(() => {
        if (data) {
            return;
        }

        let cancelled = false;
        void fetchInitialData()
            .then((nextData) => {
                if (!cancelled) {
                    setData(nextData);
                }
            })
            .catch((error: unknown) => {
                if (!cancelled) {
                    setLoadError(getErrorMessage(error));
                }
            });

        return () => {
            cancelled = true;
        };
    }, [data]);

    useEffect(() => {
        try {
            window.localStorage.setItem(DIFF_STYLE_STORAGE_KEY, diffStyle);
        } catch {
            // noop
        }
    }, [diffStyle]);

    useEffect(() => {
        if (!data || hasLoggedFirstPaint.current) {
            return;
        }

        hasLoggedFirstPaint.current = true;
        requestAnimationFrame(() => {
            console.timeEnd(APP_BOOTSTRAP_LABEL);
            console.log(
                `[diff-walkthrough] first paint committed after ${(performance.now() - MODULE_START_TIME).toFixed(1)}ms`,
                {
                    markdownLength: data.markdown.length,
                    diffBlockCount: data.resolvedBlocks.length,
                },
            );
        });
    }, [data]);

    if (loadError) {
        return (
            <main>
                <pre>
                    <code>{loadError}</code>
                </pre>
            </main>
        );
    }

    if (!data) {
        return (
            <main>
                <pre>
                    <code>Loading initial data…</code>
                </pre>
            </main>
        );
    }

    return (
        <main
            style={{
                fontFamily: "SF Pro",
                color: mode === "dark" ? "#e2e8f0" : "#0f172a",
                background: mode === "dark" ? "#000000" : "#ffffff",
                minHeight: "100vh",
                width: "100%",
            }}
        >
            <div
                style={{
                    padding: "24px 40px 64px",
                }}
            >
                <div
                    style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        gap: 12,
                        marginBottom: 20,
                    }}
                >
                    {hasDiffs &&
                        <div
                            style={{
                                display: "inline-flex",
                                border: `1px solid ${mode === "dark" ? "#334155" : "#cbd5e1"}`,
                                borderRadius: 8,
                                overflow: "hidden",
                            }}
                        >
                            {(["unified", "split"] as const).map((value, index) => {
                                const active = diffStyle === value;
                                return (
                                    <button
                                        key={value}
                                        type="button"
                                        onClick={() => setDiffStyle(value)}
                                        style={{
                                            border: "none",
                                            borderRight: index === 0 ? `1px solid ${mode === "dark" ? "#334155" : "#cbd5e1"}` : "none",
                                            background: active
                                                ? (mode === "dark" ? "#111827" : "#e2e8f0")
                                                : (mode === "dark" ? "#000000" : "#ffffff"),
                                            color: mode === "dark" ? "#e2e8f0" : "#0f172a",
                                            padding: "6px 12px",
                                            font: "inherit",
                                            cursor: "pointer",
                                            textTransform: "capitalize",
                                        }}
                                    >
                                        {value}
                                    </button>
                                );
                            })}
                        </div>
                    }
                    <button
                        type="button"
                        onClick={() => setMode(mode === "dark" ? "light" : "dark")}
                        style={{
                            marginLeft: "auto",
                            border: "1px solid",
                            borderColor: mode === "dark" ? "#334155" : "#cbd5e1",
                            background: mode === "dark" ? "#000000" : "#f8fafc",
                            color: mode === "dark" ? "#e2e8f0" : "#0f172a",
                            borderRadius: 8,
                            padding: "6px 10px",
                            font: "inherit",
                            cursor: "pointer",
                        }}
                    >
                        {mode === "dark" ? "Dark" : "Light"}
                    </button>
                </div>
                <MarkdownView
                    markdown={data.markdown}
                    resolvedBlocks={data.resolvedBlocks}
                    mode={mode}
                    diffStyle={diffStyle}
                />
            </div>
        </main>
    );
}

createRoot(document.getElementById("root")!).render(
    <StrictMode>
        <Profiler id="App" onRender={logReactProfiler}>
            <App />
        </Profiler>
    </StrictMode>,
);
