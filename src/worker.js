// Cross-device clipboard: one Durable Object per room code.
// Clients connect with a WebSocket to /api/room/<CODE>; every item pasted in the
// room is stored in the room's object and broadcast to every connected device.

const TTL_MS = 24 * 60 * 60 * 1000; // items expire after 24 hours
const MAX_ITEMS = 30; // keep only the newest items per room
const MAX_TEXT = 100_000; // characters
const MAX_IMAGE = 1_500_000; // bytes of data URL (client shrinks photos first)
const CODE_RE = /^[A-Z0-9]{4,12}$/;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const m = url.pathname.match(/^\/api\/room\/([^/]+)$/);
    if (m) {
      const code = m[1].toUpperCase();
      if (!CODE_RE.test(code)) return new Response("Bad room code", { status: 400 });
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("Expected WebSocket", { status: 426 });
      }
      const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
      return stub.fetch(request);
    }
    return new Response("Not found", { status: 404 });
  },
};

export class Room {
  constructor(ctx, env) {
    this.ctx = ctx;
    // Keep-alive pings are answered without waking the object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async fetch() {
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    const items = await this.liveItems();
    server.send(JSON.stringify({ type: "init", items, ttl: TTL_MS }));
    this.broadcastPeers();
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (msg.type === "add") {
      const item = this.validate(msg);
      if (item.error) {
        ws.send(JSON.stringify({ type: "error", message: item.error }));
        return;
      }
      await this.ctx.storage.put(key(item), item);
      await this.prune();
      await this.scheduleAlarm();
      this.broadcast({ type: "add", item });
    } else if (msg.type === "delete" && typeof msg.id === "string") {
      const all = await this.ctx.storage.list({ prefix: "item:" });
      for (const [k, v] of all) {
        if (v.id === msg.id) await this.ctx.storage.delete(k);
      }
      this.broadcast({ type: "delete", id: msg.id });
    } else if (msg.type === "clear") {
      await this.ctx.storage.deleteAll();
      this.broadcast({ type: "clear" });
    }
  }

  webSocketClose(ws, code) {
    try {
      ws.close(code === 1005 ? 1000 : code);
    } catch {}
    this.broadcastPeers();
  }

  webSocketError() {
    this.broadcastPeers();
  }

  async alarm() {
    const now = Date.now();
    const all = await this.ctx.storage.list({ prefix: "item:" });
    const expired = [];
    for (const [k, v] of all) if (v.at + TTL_MS <= now) expired.push(k);
    if (expired.length) await this.ctx.storage.delete(expired);
    for (const k of expired) this.broadcast({ type: "delete", id: all.get(k).id });
    await this.scheduleAlarm();
  }

  // ---- helpers ----

  validate(msg) {
    const id = crypto.randomUUID();
    const at = Date.now();
    if (msg.kind === "text") {
      if (typeof msg.data !== "string" || !msg.data.trim()) return { error: "Empty text" };
      if (msg.data.length > MAX_TEXT) return { error: "Text is too long" };
      return { id, at, kind: "text", data: msg.data };
    }
    if (msg.kind === "image") {
      if (typeof msg.data !== "string" || !/^data:image\/(png|jpeg|webp|gif);base64,/.test(msg.data)) {
        return { error: "Not an image" };
      }
      if (msg.data.length > MAX_IMAGE) return { error: "Image is too large" };
      const name = typeof msg.name === "string" ? msg.name.slice(0, 120) : "image";
      return { id, at, kind: "image", data: msg.data, name };
    }
    return { error: "Unknown item" };
  }

  async liveItems() {
    const now = Date.now();
    const all = await this.ctx.storage.list({ prefix: "item:" });
    return [...all.values()].filter((v) => v.at + TTL_MS > now);
  }

  async prune() {
    const all = await this.ctx.storage.list({ prefix: "item:" });
    const keys = [...all.keys()];
    if (keys.length > MAX_ITEMS) {
      const old = keys.slice(0, keys.length - MAX_ITEMS);
      await this.ctx.storage.delete(old);
      for (const k of old) this.broadcast({ type: "delete", id: all.get(k).id });
    }
  }

  async scheduleAlarm() {
    const first = await this.ctx.storage.list({ prefix: "item:", limit: 1 });
    const [item] = first.values();
    if (item) await this.ctx.storage.setAlarm(item.at + TTL_MS);
    else await this.ctx.storage.deleteAlarm();
  }

  sockets() {
    return this.ctx.getWebSockets().filter((s) => s.readyState === WebSocket.OPEN);
  }

  broadcast(obj) {
    const data = JSON.stringify(obj);
    for (const s of this.sockets()) {
      try {
        s.send(data);
      } catch {}
    }
  }

  broadcastPeers() {
    this.broadcast({ type: "peers", count: this.sockets().length });
  }
}

// Keys sort by time so the oldest item is listed first.
function key(item) {
  return `item:${String(item.at).padStart(15, "0")}:${item.id}`;
}
