#!/usr/bin/env -S pnpm dlx tsx

import { parseArgs } from "node:util";

try {
  process.loadEnvFile(new URL("./.env", import.meta.url));
} catch {}

const API_KEY = process.env.LINEAR_API_KEY?.trim();
if (!API_KEY) {
  process.stderr.write("Missing LINEAR_API_KEY in .env (Linear > Settings > Security & access > Personal API keys)\n");
  process.exit(1);
}

const { values: opts, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    json: { type: "boolean" },
    mine: { type: "boolean" },
    all: { type: "boolean" },
    team: { type: "string" },
    state: { type: "string" },
    assignee: { type: "string" },
    project: { type: "string" },
    search: { type: "string" },
    limit: { type: "string", default: "25" },
    title: { type: "string" },
    description: { type: "string" },
    priority: { type: "string" },
    label: { type: "string" },
    parent: { type: "string" },
    vars: { type: "string" },
  },
});
const [command, arg1, arg2] = positionals;

type Json = Record<string, unknown>;

async function gql<T = Json>(query: string, variables: Json = {}): Promise<T> {
  const res = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: { Authorization: API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const body = (await res.json()) as { data?: T; errors?: { message: string }[] };
  if (!res.ok || body.errors?.length) {
    throw new Error(`Linear API ${res.status}: ${body.errors?.map((e) => e.message).join("; ") ?? "unknown error"}`);
  }
  return body.data!;
}

const ISSUE_FIELDS = `
  id identifier title priority priorityLabel url updatedAt
  state { name type } assignee { displayName } project { name }
  labels { nodes { name } } parent { identifier }
`;

const ISSUE_DETAIL_FIELDS = `${ISSUE_FIELDS} description
  children { nodes { identifier title state { name } } }
  comments { nodes { body createdAt user { displayName } } }
`;

type Issue = {
  id: string;
  identifier: string;
  title: string;
  priority: number;
  priorityLabel: string;
  url: string;
  updatedAt: string;
  state: { name: string; type: string };
  assignee: { displayName: string } | null;
  project: { name: string } | null;
  labels: { nodes: { name: string }[] };
  parent: { identifier: string } | null;
  description?: string | null;
  children?: { nodes: { identifier: string; title: string; state: { name: string } }[] };
  comments?: { nodes: { body: string; createdAt: string; user: { displayName: string } | null }[] };
};

type Named = { id: string; name: string };

function out(value: unknown, text: () => string): void {
  process.stdout.write(opts.json ? `${JSON.stringify(value, null, 2)}\n` : `${text()}\n`);
}

function issueLine(i: Issue): string {
  const labels = i.labels.nodes.map((l) => l.name);
  return [
    i.identifier,
    i.state.name,
    i.priorityLabel,
    `@${i.assignee?.displayName ?? "unassigned"}`,
    i.title,
    labels.length ? `[${labels.join(", ")}]` : "",
    i.project ? `(${i.project.name})` : "",
  ]
    .filter(Boolean)
    .join("  ");
}

function eqIgnoreCase(name: string, candidates: Named[], kind: string): Named {
  const found = candidates.find((c) => c.name.toLowerCase() === name.toLowerCase());
  if (!found) throw new Error(`No ${kind} named "${name}". Options: ${candidates.map((c) => c.name).join(", ")}`);
  return found;
}

async function teamMeta(teamKey: string) {
  const data = await gql<{
    teams: {
      nodes: {
        id: string;
        key: string;
        name: string;
        states: { nodes: (Named & { type: string })[] };
        labels: { nodes: Named[] };
        members: { nodes: { id: string; name: string; displayName: string; email: string }[] };
        projects: { nodes: (Named & { state: string })[] };
      }[];
    };
    issueLabels: { nodes: Named[] };
  }>(
    `query($key: String!) {
      teams(filter: { key: { eq: $key } }) { nodes {
        id key name
        states { nodes { id name type } }
        labels { nodes { id name } }
        members { nodes { id name displayName email } }
        projects { nodes { id name state } }
      } }
      issueLabels(filter: { team: { null: true } }) { nodes { id name } }
    }`,
    { key: teamKey },
  );
  const team = data.teams.nodes[0];
  if (!team) throw new Error(`No team with key "${teamKey}"`);
  return { ...team, labels: { nodes: [...team.labels.nodes, ...data.issueLabels.nodes] } };
}

type Meta = Awaited<ReturnType<typeof teamMeta>>;

async function resolveAssignee(meta: Meta, who: string): Promise<string> {
  if (who === "me") {
    const { viewer } = await gql<{ viewer: { id: string } }>(`{ viewer { id } }`);
    return viewer.id;
  }
  const q = who.toLowerCase();
  const found = meta.members.nodes.find((m) =>
    [m.name, m.displayName, m.email].some((s) => s.toLowerCase().includes(q)),
  );
  if (!found) throw new Error(`No member matching "${who}" in ${meta.key}`);
  return found.id;
}

async function buildInput(meta: Meta): Promise<Json> {
  const input: Json = {};
  if (opts.title) input.title = opts.title;
  if (opts.description) input.description = opts.description;
  if (opts.priority) input.priority = Number(opts.priority);
  if (opts.state) input.stateId = eqIgnoreCase(opts.state, meta.states.nodes, "state").id;
  if (opts.assignee) input.assigneeId = await resolveAssignee(meta, opts.assignee);
  if (opts.project) input.projectId = eqIgnoreCase(opts.project, meta.projects.nodes, "project").id;
  if (opts.label) {
    input.labelIds = opts.label.split(",").map((l) => eqIgnoreCase(l.trim(), meta.labels.nodes, "label").id);
  }
  if (opts.parent) {
    const { issue } = await gql<{ issue: { id: string } }>(`query($id: String!) { issue(id: $id) { id } }`, {
      id: opts.parent,
    });
    input.parentId = issue.id;
  }
  return input;
}

async function main(): Promise<void> {
  switch (command) {
    case "me": {
      const data = await gql<{
        viewer: { id: string; name: string; displayName: string; email: string };
        teams: { nodes: { id: string; key: string; name: string }[] };
      }>(`{ viewer { id name displayName email } teams { nodes { id key name } } }`);
      out(data, () =>
        [
          `${data.viewer.displayName} <${data.viewer.email}>`,
          ...data.teams.nodes.map((t) => `${t.key}  ${t.name}`),
        ].join("\n"),
      );
      return;
    }

    case "issues": {
      const and: Json[] = [];
      const hasFilter = opts.team || opts.assignee || opts.project || opts.search;
      if (opts.mine || !hasFilter) and.push({ assignee: { isMe: { eq: true } } });
      if (opts.team) and.push({ team: { key: { eq: opts.team } } });
      if (opts.state) and.push({ state: { name: { eqIgnoreCase: opts.state } } });
      else if (!opts.all) and.push({ state: { type: { nin: ["completed", "canceled"] } } });
      if (opts.assignee === "me") and.push({ assignee: { isMe: { eq: true } } });
      else if (opts.assignee) {
        and.push({
          assignee: {
            or: [
              { name: { containsIgnoreCase: opts.assignee } },
              { displayName: { containsIgnoreCase: opts.assignee } },
            ],
          },
        });
      }
      if (opts.project) and.push({ project: { name: { containsIgnoreCase: opts.project } } });
      if (opts.search) {
        and.push({
          or: [{ title: { containsIgnoreCase: opts.search } }, { description: { containsIgnoreCase: opts.search } }],
        });
      }
      const data = await gql<{ issues: { nodes: Issue[] } }>(
        `query($filter: IssueFilter, $first: Int) {
          issues(filter: $filter, first: $first, orderBy: updatedAt) { nodes { ${ISSUE_FIELDS} } }
        }`,
        { filter: { and }, first: Number(opts.limit) },
      );
      out(data.issues.nodes, () => data.issues.nodes.map(issueLine).join("\n") || "No issues.");
      return;
    }

    case "issue": {
      if (!arg1) throw new Error("Usage: linear issue ENG-123");
      const { issue } = await gql<{ issue: Issue }>(
        `query($id: String!) { issue(id: $id) { ${ISSUE_DETAIL_FIELDS} } }`,
        { id: arg1 },
      );
      out(issue, () => {
        const lines = [issueLine(issue), issue.url];
        if (issue.parent) lines.push(`parent: ${issue.parent.identifier}`);
        lines.push("", issue.description?.trim() || "(no description)");
        if (issue.children?.nodes.length) {
          lines.push("", "sub-issues:");
          for (const c of issue.children.nodes) lines.push(`  ${c.identifier}  ${c.state.name}  ${c.title}`);
        }
        if (issue.comments?.nodes.length) {
          lines.push("", "comments:");
          for (const c of issue.comments.nodes) {
            lines.push(`  [${c.createdAt.slice(0, 10)}] ${c.user?.displayName ?? "?"}: ${c.body.trim()}`);
          }
        }
        return lines.join("\n");
      });
      return;
    }

    case "create": {
      if (!opts.team || !opts.title) throw new Error("Usage: linear create --team ENG --title '...' [options]");
      const meta = await teamMeta(opts.team);
      const input = { teamId: meta.id, ...(await buildInput(meta)) };
      const data = await gql<{ issueCreate: { issue: Issue } }>(
        `mutation($input: IssueCreateInput!) { issueCreate(input: $input) { issue { ${ISSUE_FIELDS} } } }`,
        { input },
      );
      out(data.issueCreate.issue, () => `Created ${issueLine(data.issueCreate.issue)}\n${data.issueCreate.issue.url}`);
      return;
    }

    case "update": {
      if (!arg1) throw new Error("Usage: linear update ENG-123 [options]");
      const { issue } = await gql<{ issue: { id: string; team: { key: string } } }>(
        `query($id: String!) { issue(id: $id) { id team { key } } }`,
        { id: arg1 },
      );
      const meta = await teamMeta(issue.team.key);
      const input = await buildInput(meta);
      if (Object.keys(input).length === 0) throw new Error("Nothing to update");
      const data = await gql<{ issueUpdate: { issue: Issue } }>(
        `mutation($id: String!, $input: IssueUpdateInput!) {
          issueUpdate(id: $id, input: $input) { issue { ${ISSUE_FIELDS} } }
        }`,
        { id: issue.id, input },
      );
      out(data.issueUpdate.issue, () => `Updated ${issueLine(data.issueUpdate.issue)}`);
      return;
    }

    case "comment": {
      if (!arg1 || !arg2) throw new Error("Usage: linear comment ENG-123 'text'");
      const { issue } = await gql<{ issue: { id: string } }>(`query($id: String!) { issue(id: $id) { id } }`, {
        id: arg1,
      });
      const data = await gql<{ commentCreate: { comment: { id: string; url: string } } }>(
        `mutation($input: CommentCreateInput!) { commentCreate(input: $input) { comment { id url } } }`,
        { input: { issueId: issue.id, body: arg2 } },
      );
      out(data.commentCreate.comment, () => `Commented on ${arg1}: ${data.commentCreate.comment.url}`);
      return;
    }

    case "meta": {
      if (!opts.team) throw new Error("Usage: linear meta --team ENG");
      const meta = await teamMeta(opts.team);
      out(meta, () =>
        [
          `${meta.key}  ${meta.name}  ${meta.id}`,
          "",
          "states:",
          ...meta.states.nodes.map((s) => `  ${s.name}  (${s.type})  ${s.id}`),
          "",
          "labels:",
          ...meta.labels.nodes.map((l) => `  ${l.name}  ${l.id}`),
          "",
          "members:",
          ...meta.members.nodes.map((m) => `  ${m.displayName}  ${m.name}  ${m.email}  ${m.id}`),
          "",
          "projects:",
          ...meta.projects.nodes.map((p) => `  ${p.name}  (${p.state})  ${p.id}`),
        ].join("\n"),
      );
      return;
    }

    case "gql": {
      if (!arg1) throw new Error("Usage: linear gql '<query>' [--vars '{...}']");
      const data = await gql(arg1, opts.vars ? JSON.parse(opts.vars) : {});
      process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
      return;
    }

    default:
      throw new Error("Usage: linear <me|issues|issue|create|update|comment|meta|gql> [options]");
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
