/**
 * Matrix client using matrix-bot-sdk with E2EE via native Rust crypto.
 * Persistent crypto store (SQLite) at ~/.matrix-mcp-server/
 */

import {
  MatrixClient,
  SimpleFsStorageProvider,
  AutojoinRoomsMixin,
  RustSdkCryptoStorageProvider,
  LogService,
  LogLevel,
} from "matrix-bot-sdk";
import { StoreType } from "@matrix-org/matrix-sdk-crypto-nodejs";
import * as path from "node:path";
import * as fs from "node:fs";

const homeserver = process.env.MATRIX_HOMESERVER!;
const accessToken = process.env.MATRIX_ACCESS_TOKEN!;

const dataDir = path.join(
  process.env.HOME ?? "/tmp",
  ".matrix-mcp-server",
);

// Redirect all matrix-bot-sdk logging to stderr (stdout is MCP JSON-RPC)
LogService.setLevel(LogLevel.WARN);
LogService.setLogger({
  info: (...args: unknown[]) => console.error("[matrix-info]", ...args),
  warn: (...args: unknown[]) => console.error("[matrix-warn]", ...args),
  error: (...args: unknown[]) => console.error("[matrix-error]", ...args),
  debug: (..._args: unknown[]) => {},
  trace: (..._args: unknown[]) => {},
});

let client: MatrixClient | null = null;
let initPromise: Promise<MatrixClient> | null = null;

// Sender allowlist — parsed from MATRIX_ALLOWED_USERS env (comma-separated)
const allowedUsers: Set<string> | null = process.env.MATRIX_ALLOWED_USERS
  ? new Set(process.env.MATRIX_ALLOWED_USERS.split(",").map((s) => s.trim()).filter(Boolean))
  : null; // null = allow all

// Channel notification callback — set by index.ts when channel mode is active
let channelNotify: ((roomId: string, event: Record<string, unknown>) => void) | null = null;

export function setChannelNotify(
  fn: (roomId: string, event: Record<string, unknown>) => void,
): void {
  channelNotify = fn;
}

export async function ensureClient(): Promise<MatrixClient> {
  if (client) return client;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    fs.mkdirSync(dataDir, { recursive: true });

    const storage = new SimpleFsStorageProvider(
      path.join(dataDir, "bot-state.json"),
    );

    // Try E2EE crypto store; fall back to plain client if locked/conflicting
    let crypto: RustSdkCryptoStorageProvider | undefined;
    try {
      crypto = new RustSdkCryptoStorageProvider(
        path.join(dataDir, "crypto"),
        StoreType.Sqlite,
      );
    } catch (err) {
      console.error("Crypto store unavailable, running without E2EE:", err);
    }

    const c = crypto
      ? new MatrixClient(homeserver, accessToken, storage, crypto)
      : new MatrixClient(homeserver, accessToken, storage);
    AutojoinRoomsMixin.setupOnClient(c);

    // The client is usable for API calls immediately
    client = c;

    const myUserId = await c.getUserId();
    c.on("room.message", (roomId: string, event: Record<string, unknown>) => {
      const content = event.content as Record<string, unknown> | undefined;
      if (!content?.msgtype) return;
      if (event.sender === myUserId) return;

      // Sender gating
      if (allowedUsers && !allowedUsers.has(event.sender as string)) return;

      // Push to channel if active
      if (channelNotify) {
        channelNotify(roomId, event);
      }
    });

    // Start the sync loop — if E2EE key upload conflicts (another instance
    // already owns this device), catch it and keep tools working without sync.
    try {
      await c.start();
      console.error("Matrix bot-sdk client ready" + (crypto ? " with E2EE" : " (no E2EE)"));
    } catch (err) {
      console.error("Matrix sync/E2EE init failed — tools still available via API:", err);
    }

    return c;
  })();

  return initPromise;
}

// ── Room operations ──

export interface RoomInfo {
  room_id: string;
  name?: string;
  encrypted: boolean;
  member_count: number;
}

export async function listJoinedRooms(): Promise<RoomInfo[]> {
  const c = await ensureClient();
  const roomIds = await c.getJoinedRooms();
  const results: RoomInfo[] = [];

  for (const roomId of roomIds) {
    let name: string | undefined;
    let encrypted = false;
    let memberCount = 0;

    try {
      const state = await c.getRoomStateEvent(roomId, "m.room.name", "");
      name = state?.name;
    } catch {}

    try {
      await c.getRoomStateEvent(roomId, "m.room.encryption", "");
      encrypted = true;
    } catch {}

    try {
      const members = await c.getJoinedRoomMembers(roomId);
      memberCount = members.length;
    } catch {}

    results.push({ room_id: roomId, name, encrypted, member_count: memberCount });
  }

  return results;
}

export async function createRoom(
  name: string,
  topic?: string,
  inviteUserIds?: string[],
  encrypted: boolean = true,
): Promise<string> {
  const c = await ensureClient();
  const myUserId = await c.getUserId();

  // Filter out the bot's own user ID to avoid M_FORBIDDEN on self-invite
  const invite = inviteUserIds?.filter((id) => id !== myUserId);

  const initialState: Array<{ type: string; state_key: string; content: Record<string, unknown> }> = [];
  if (encrypted) {
    initialState.push({
      type: "m.room.encryption",
      state_key: "",
      content: { algorithm: "m.megolm.v1.aes-sha2" },
    });
  }

  const roomId = await c.createRoom({
    name,
    topic,
    invite: invite?.length ? invite : undefined,
    preset: "private_chat",
    visibility: "private",
    initial_state: initialState,
  });

  return roomId;
}

export async function joinRoom(roomIdOrAlias: string): Promise<string> {
  const c = await ensureClient();
  return await c.joinRoom(roomIdOrAlias);
}

export async function inviteUser(roomId: string, userId: string): Promise<void> {
  const c = await ensureClient();
  await c.inviteUser(userId, roomId);
}

// ── Messaging ──

export async function sendMessage(
  roomId: string,
  body: string,
  html?: string,
): Promise<string> {
  const c = await ensureClient();
  const content: Record<string, unknown> = {
    msgtype: "m.text",
    body,
  };
  if (html) {
    content.format = "org.matrix.custom.html";
    content.formatted_body = html;
  }
  return await c.sendMessage(roomId, content);
}

export async function sendNotice(roomId: string, body: string): Promise<string> {
  const c = await ensureClient();
  return await c.sendNotice(roomId, body);
}

export interface MessageSummary {
  event_id: string;
  sender: string;
  timestamp: string;
  body: string;
}

export async function readMessages(
  roomId: string,
  limit: number = 20,
): Promise<MessageSummary[]> {
  const c = await ensureClient();

  // Use the room event stream to get recent messages
  const events = await c.doRequest(
    "GET",
    `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/messages`,
    { dir: "b", limit: String(limit), filter: JSON.stringify({ types: ["m.room.message"] }) },
  );

  const messages: MessageSummary[] = [];
  for (const event of (events.chunk ?? []).reverse()) {
    if (event.type !== "m.room.message") continue;
    messages.push({
      event_id: event.event_id,
      sender: event.sender,
      timestamp: new Date(event.origin_server_ts).toISOString(),
      body: event.content?.body ?? "",
    });
  }

  return messages;
}

// ── Typing indicator ──

export async function setTyping(
  roomId: string,
  typing: boolean,
  timeoutMs: number = 30000,
): Promise<void> {
  const c = await ensureClient();
  const userId = await c.getUserId();
  await c.doRequest(
    "PUT",
    `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/typing/${encodeURIComponent(userId)}`,
    undefined,
    { typing, timeout: timeoutMs },
  );
}

// ── Enable encryption on existing room ──

export async function enableEncryption(roomId: string): Promise<void> {
  const c = await ensureClient();
  await c.sendStateEvent(roomId, "m.room.encryption", "", {
    algorithm: "m.megolm.v1.aes-sha2",
  });
}

// ── Cleanup ──

export async function stopClient(): Promise<void> {
  if (client) {
    client.stop();
    client = null;
    initPromise = null;
  }
}
