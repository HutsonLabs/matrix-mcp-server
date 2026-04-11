#!/usr/bin/env node
/**
 * Matrix MCP Server + Channel Plugin
 *
 * Exposes Matrix messaging as MCP tools with E2EE support.
 * Also acts as a Claude Code Channel — incoming Matrix messages
 * push directly into the conversation via notifications/claude/channel.
 *
 * Transport: stdio
 *
 * Required env vars:
 *   MATRIX_HOMESERVER     — e.g. https://chat.example.com
 *   MATRIX_ACCESS_TOKEN   — bot access token
 *
 * Optional env vars:
 *   MATRIX_ALLOWED_USERS  — comma-separated list of Matrix user IDs to accept
 *                           messages from (omit to accept all)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as matrix from "./matrix.js";

for (const key of ["MATRIX_HOMESERVER", "MATRIX_ACCESS_TOKEN"]) {
  if (!process.env[key]) {
    console.error(`Missing required env var: ${key}`);
    process.exit(1);
  }
}

const server = new McpServer(
  {
    name: "matrix-mcp-server",
    version: "1.0.0",
  },
  {
    capabilities: {
      experimental: {
        "claude/channel": {},
      },
    },
    instructions:
      'Incoming Matrix messages arrive as <channel source="matrix"> tags with room_id, sender, message_id, and ts attributes. ' +
      "To reply, use the matrix_send_message tool with the room_id from the tag. " +
      "You can also use matrix_read_messages to fetch history from a room.",
  },
);

// ── Channel: push incoming Matrix messages into Claude ──

matrix.setChannelNotify((roomId, event) => {
  const content = event.content as Record<string, unknown>;
  const body = (content.body as string) ?? "";
  const sender = event.sender as string;
  const eventId = event.event_id as string;
  const ts = new Date(event.origin_server_ts as number).toISOString();

  server.server.notification({
    method: "notifications/claude/channel" as any,
    params: {
      content: body,
      meta: {
        room_id: roomId,
        sender,
        message_id: eventId,
        ts,
      },
    },
  }).catch((err) => {
    console.error("Channel notification failed:", err);
  });
});

// ── Tools ──

server.tool(
  "matrix_send_message",
  "Send a text message to a Matrix room (encrypted if room has E2EE enabled)",
  {
    room_id: z.string().describe("Room ID (e.g. !abc:chat.example.com)"),
    message: z.string().describe("Message text"),
    html: z.string().optional().describe("Optional HTML-formatted version"),
  },
  async ({ room_id, message, html }) => {
    const eventId = await matrix.sendMessage(room_id, message, html);
    return { content: [{ type: "text", text: `Sent (event: ${eventId})` }] };
  },
);

server.tool(
  "matrix_send_notice",
  "Send a notice (non-highlighted) to a Matrix room",
  {
    room_id: z.string().describe("Room ID"),
    message: z.string().describe("Notice text"),
  },
  async ({ room_id, message }) => {
    const eventId = await matrix.sendNotice(room_id, message);
    return { content: [{ type: "text", text: `Notice sent (event: ${eventId})` }] };
  },
);

server.tool(
  "matrix_read_messages",
  "Read recent messages from a Matrix room",
  {
    room_id: z.string().describe("Room ID"),
    limit: z.number().min(1).max(100).default(20).describe("Number of messages (default 20)"),
  },
  async ({ room_id, limit }) => {
    const messages = await matrix.readMessages(room_id, limit);
    if (messages.length === 0) {
      return { content: [{ type: "text", text: "No messages found." }] };
    }
    const text = messages
      .map((m) => `[${m.timestamp}] ${m.sender}: ${m.body}`)
      .join("\n");
    return { content: [{ type: "text", text }] };
  },
);

server.tool(
  "matrix_list_rooms",
  "List all Matrix rooms the bot has joined",
  {},
  async () => {
    const rooms = await matrix.listJoinedRooms();
    if (rooms.length === 0) {
      return { content: [{ type: "text", text: "Not in any rooms." }] };
    }
    const text = rooms
      .map((r) =>
        `${r.room_id}  ${r.name ?? "(unnamed)"}  encrypted: ${r.encrypted}  members: ${r.member_count}`,
      )
      .join("\n");
    return { content: [{ type: "text", text }] };
  },
);

server.tool(
  "matrix_create_room",
  "Create a new encrypted Matrix room and optionally invite users",
  {
    name: z.string().describe("Room name"),
    topic: z.string().optional().describe("Room topic"),
    invite: z.array(z.string()).optional().describe("User IDs to invite"),
    encrypted: z.boolean().default(true).describe("Enable E2EE (default true)"),
  },
  async ({ name, topic, invite, encrypted }) => {
    const roomId = await matrix.createRoom(name, topic, invite, encrypted);
    return { content: [{ type: "text", text: `Room created: ${roomId}` }] };
  },
);

server.tool(
  "matrix_join_room",
  "Join a Matrix room by ID or alias",
  { room_id: z.string().describe("Room ID or alias") },
  async ({ room_id }) => {
    const roomId = await matrix.joinRoom(room_id);
    return { content: [{ type: "text", text: `Joined: ${roomId}` }] };
  },
);

server.tool(
  "matrix_invite_user",
  "Invite a user to a Matrix room",
  {
    room_id: z.string().describe("Room ID"),
    user_id: z.string().describe("User ID to invite"),
  },
  async ({ room_id, user_id }) => {
    await matrix.inviteUser(room_id, user_id);
    return { content: [{ type: "text", text: `Invited ${user_id} to ${room_id}` }] };
  },
);

server.tool(
  "matrix_set_typing",
  "Show or hide typing indicator",
  {
    room_id: z.string().describe("Room ID"),
    typing: z.boolean().describe("true to show, false to hide"),
  },
  async ({ room_id, typing }) => {
    await matrix.setTyping(room_id, typing);
    return { content: [{ type: "text", text: typing ? "Typing on" : "Typing off" }] };
  },
);

server.tool(
  "matrix_enable_encryption",
  "Enable E2EE on an existing room (irreversible)",
  { room_id: z.string().describe("Room ID") },
  async ({ room_id }) => {
    await matrix.enableEncryption(room_id);
    return { content: [{ type: "text", text: `Encryption enabled on ${room_id}` }] };
  },
);

// ── Start ──

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Matrix MCP Server running — 9 tools + channel registered (E2EE lazy-init)");

  // Start Matrix client in background (non-blocking)
  matrix.ensureClient().catch((err) => {
    console.error("Matrix client init failed:", err);
  });

  // Graceful shutdown
  process.on("SIGINT", async () => {
    await matrix.stopClient();
    process.exit(0);
  });
  process.on("SIGTERM", async () => {
    await matrix.stopClient();
    process.exit(0);
  });
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
