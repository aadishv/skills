#!/usr/bin/env bun

import { mkdir } from "node:fs/promises";

type Command = "send" | "queue" | "wait";

type Format = "text" | "json";

type Env = {
  token: string;
  userId: string;
};

type State = {
  dmChannelId?: string;
  cursor?: string;
  botUserId?: string;
};

type DiscordUser = {
  id: string;
  username: string;
  global_name: string | null;
};

type DiscordMessage = {
  id: string;
  content: string;
  timestamp: string;
  author: DiscordUser;
};

type OutputMessage = {
  id: string;
  content: string;
  timestamp: string;
  author: {
    id: string;
    username: string;
    globalName: string | null;
  };
};

const API_BASE = "https://discord.com/api/v10";
const POLL_INTERVAL_MS = 5_000;
const BURST_WINDOW_MS = 60_000;
const STATE_PATH = new URL("./runtime/state.json", import.meta.url);
const STATE_DIR = new URL("./runtime/", import.meta.url);

function getEnv(): Env {
  const token = Bun.env.DISCORD_BOT_TOKEN?.trim();
  const userId = Bun.env.DISCORD_USER_ID?.trim();

  if (!token) {
    throw new Error("Missing DISCORD_BOT_TOKEN in .env");
  }

  if (!userId) {
    throw new Error("Missing DISCORD_USER_ID in .env");
  }

  return { token, userId };
}

async function readState(): Promise<State> {
  const file = Bun.file(STATE_PATH);
  if (!(await file.exists())) {
    return {};
  }

  const parsed = JSON.parse(await file.text()) as unknown;
  if (!parsed || typeof parsed !== "object") {
    return {};
  }

  return parsed as State;
}

async function writeState(state: State): Promise<void> {
  await mkdir(STATE_DIR, { recursive: true });
  await Bun.write(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`);
}

async function discordFetch<T>(env: Env, path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bot ${env.token}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });

  if (!response.ok) {
    throw new Error(`Discord API error ${response.status}: ${await response.text()}`);
  }

  return (await response.json()) as T;
}

async function getBotUserId(env: Env, state: State): Promise<string> {
  if (state.botUserId) {
    return state.botUserId;
  }

  const me = await discordFetch<{ id: string }>(env, "/users/@me");
  state.botUserId = me.id;
  await writeState(state);
  return me.id;
}

async function getDmChannelId(env: Env, state: State): Promise<string> {
  if (state.dmChannelId) {
    return state.dmChannelId;
  }

  const channel = await discordFetch<{ id: string }>(env, "/users/@me/channels", {
    method: "POST",
    body: JSON.stringify({ recipient_id: env.userId }),
  });

  state.dmChannelId = channel.id;
  await writeState(state);
  return channel.id;
}

function sortMessagesAscending(messages: DiscordMessage[]): DiscordMessage[] {
  return [...messages].sort((a, b) => {
    const left = BigInt(a.id);
    const right = BigInt(b.id);
    if (left < right) return -1;
    if (left > right) return 1;
    return 0;
  });
}

function toOutputMessage(message: DiscordMessage): OutputMessage {
  return {
    id: message.id,
    content: message.content,
    timestamp: message.timestamp,
    author: {
      id: message.author.id,
      username: message.author.username,
      globalName: message.author.global_name,
    },
  };
}

async function fetchInboundMessages(env: Env, state: State): Promise<OutputMessage[]> {
  const channelId = await getDmChannelId(env, state);
  const botUserId = await getBotUserId(env, state);

  const query = new URLSearchParams({ limit: "100" });
  if (state.cursor) {
    query.set("after", state.cursor);
  }

  const messages = await discordFetch<DiscordMessage[]>(env, `/channels/${channelId}/messages?${query.toString()}`);
  const inbound = sortMessagesAscending(messages).filter((message) => {
    return message.author.id !== botUserId && message.author.id === env.userId;
  });

  return inbound.map(toOutputMessage);
}

async function commitCursor(state: State, messages: OutputMessage[]): Promise<void> {
  const lastMessage = messages.at(-1);
  if (!lastMessage) {
    return;
  }

  state.cursor = lastMessage.id;
  await writeState(state);
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function parseFormat(args: string[]): Format {
  return args.includes("--json") ? "json" : "text";
}

function parseSendMessage(args: string[]): string {
  const messageFlagIndex = args.findIndex((arg) => arg === "--message");
  if (messageFlagIndex === -1) {
    throw new Error("Missing --message");
  }

  const message = args[messageFlagIndex + 1];
  if (!message) {
    throw new Error("Missing value for --message");
  }

  return message;
}

function formatRelativeTime(timestamp: string): string {
  const deltaMs = Math.max(0, Date.now() - Date.parse(timestamp));
  const seconds = Math.floor(deltaMs / 1000);
  if (seconds < 60) {
    return `${seconds} second${seconds === 1 ? "" : "s"} ago`;
  }

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  }

  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  }

  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

function formatMessageText(message: OutputMessage): string {
  const authorName = message.author.globalName ?? message.author.username;
  return `[${formatRelativeTime(message.timestamp)}] [${authorName}] ${message.content}`;
}

async function sendMessage(env: Env, state: State, message: string, format: Format): Promise<void> {
  const channelId = await getDmChannelId(env, state);
  const response = await discordFetch<DiscordMessage>(env, `/channels/${channelId}/messages`, {
    method: "POST",
    body: JSON.stringify({ content: message }),
  });

  const output = toOutputMessage(response);
  if (format === "json") {
    printJson({
      ok: true,
      message: output,
    });
    return;
  }

  process.stdout.write(`Sent: ${formatMessageText(output)}\n`);
}

async function queueMessages(env: Env, state: State, format: Format): Promise<void> {
  const messages = await fetchInboundMessages(env, state);
  await commitCursor(state, messages);

  if (format === "json") {
    printJson({
      ok: true,
      messages,
    });
    return;
  }

  if (messages.length === 0) {
    process.stdout.write("No new messages.\n");
    return;
  }

  process.stdout.write(`${messages.length} new message${messages.length === 1 ? "" : "s"}:\n`);
  for (const message of messages) {
    process.stdout.write(`${formatMessageText(message)}\n`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForMessages(env: Env, state: State, format: Format): Promise<void> {
  while (true) {
    const initialBatch = await fetchInboundMessages(env, state);
    if (initialBatch.length === 0) {
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    const collected = [...initialBatch];
    const seenIds = new Set(collected.map((message) => message.id));
    const deadline = Date.now() + BURST_WINDOW_MS;

    while (Date.now() < deadline) {
      await sleep(POLL_INTERVAL_MS);
      const nextBatch = await fetchInboundMessages(env, state);
      for (const message of nextBatch) {
        if (seenIds.has(message.id)) {
          continue;
        }
        seenIds.add(message.id);
        collected.push(message);
      }
    }

    collected.sort((a, b) => {
      const left = BigInt(a.id);
      const right = BigInt(b.id);
      if (left < right) return -1;
      if (left > right) return 1;
      return 0;
    });

    await commitCursor(state, collected);
    if (format === "json") {
      printJson({
        ok: true,
        messages: collected,
        windowMs: BURST_WINDOW_MS,
      });
      return;
    }

    process.stdout.write(`Received ${collected.length} new message${collected.length === 1 ? "" : "s"} after waiting.\n`);
    for (const message of collected) {
      process.stdout.write(`${formatMessageText(message)}\n`);
    }
    return;
  }
}

function parseCommand(args: string[]): Command {
  const command = args[0];
  if (command === "send" || command === "queue" || command === "wait") {
    return command;
  }

  throw new Error("Usage: bun ./discord.ts <send|queue|wait> [options]");
}

async function main(): Promise<void> {
  const args = Bun.argv.slice(2);
  const command = parseCommand(args);
  const env = getEnv();
  const state = await readState();
  const format = parseFormat(args.slice(1));

  if (command === "send") {
    await sendMessage(env, state, parseSendMessage(args.slice(1)), format);
    return;
  }

  if (command === "queue") {
    await queueMessages(env, state, format);
    return;
  }

  await waitForMessages(env, state, format);
}

await main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
