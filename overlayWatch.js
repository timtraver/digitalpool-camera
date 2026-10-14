// One GraphQL subscription socket, shared by every overlay on the box.
//
// Why a socket at all, when overlayDataSource can already answer the same
// question with a cheap poll: the poll is the thing that never stops. A venue
// device sits on an empty table for most of the day, and at one probe every
// 20 s that is ~4,300 requests per camera per day, forever, to be told that
// nothing has changed. Hasura pushes only when a result actually changes — a
// box watching an idle table measured ONE payload in 25 s, the initial result,
// and nothing after it. Detection also stops being a function of the poll
// interval: a match assigned to the table arrives immediately instead of up to
// IDLE_POLL_MS later.
//
// It is deliberately not a general GraphQL client:
//
//   • It carries the PROBE documents only. The full binding query stays a poll,
//     because a subscription would make Hasura re-run that query server-side on
//     every refetch interval — more work against the expensive query, not less.
//     The cheap question is the one worth holding open.
//
//   • It is never load-bearing. Every watcher still has its poll behind it, and
//     a socket that is down just means the caller keeps polling at the idle
//     cadence. Nothing in the render path ever waits on a frame that may never
//     arrive — these boxes sit on venue WiFi and LTE behind NAT, and a
//     long-lived connection WILL drop.
//
// Protocol is graphql-transport-ws (the modern graphql-ws one). api-prod speaks
// both that and the legacy subscriptions-transport-ws; this picks the current
// one. Keepalives are sent as protocol-level ping/pong frames rather than
// WebSocket control frames, because those survive proxies more reliably — the
// endpoint is behind Cloudflare.
const EventEmitter = require("events");

// ws is already present as a transitive dependency of socket.io, and is now
// declared directly. Loading it defensively anyway: a box whose node_modules is
// missing it must fall back to polling, not fail to render an overlay.
// OVERLAY_WATCH=0 is the retreat: it forces every overlay back onto the idle
// poll, which is a complete implementation on its own. One env var and a
// restart, with no revert, if subscriptions ever misbehave in the field.
let WebSocket = null;
if (process.env.OVERLAY_WATCH === "0") {
  console.log("🎛️  OVERLAY_WATCH=0 — overlays will poll rather than subscribe");
} else {
  try {
    WebSocket = require("ws");
  } catch (err) {
    console.log("ℹ️  ws unavailable — overlay watch will poll instead:", err.message);
  }
}

const SUBPROTOCOL = "graphql-transport-ws";

// Keepalive. NAT gateways reap idle flows at around 5 minutes and this socket is
// idle by design, so something has to move on it.
const PING_MS = parseInt(process.env.OVERLAY_WATCH_PING_MS, 10) || 30000;
// No pong within this long after a ping means the socket is gone even though
// the OS has not noticed. Terminate and reconnect.
const PONG_TIMEOUT_MS = parseInt(process.env.OVERLAY_WATCH_PONG_TIMEOUT_MS, 10) || 15000;
const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 60000;

function wsUrl(httpUrl) {
  return httpUrl.replace(/^http:/i, "ws:").replace(/^https:/i, "wss:");
}

class OverlayWatch extends EventEmitter {
  constructor() {
    super();
    this._ws = null;
    this._connected = false;     // socket open AND connection_ack received
    this._watchers = new Map();  // id -> { query, variables, onData }
    this._nextId = 1;
    this._attempt = 0;
    this._reconnectTimer = null;
    this._pingTimer = null;
    this._pongTimer = null;
    this._wantOpen = false;
    this._url = null;
  }

  get connected() {
    return this._connected;
  }

  get available() {
    return !!WebSocket;
  }

  /**
   * Watch one document. Returns a handle with close(); the caller keeps its
   * poll as the fallback and uses `connected` to decide which one is in charge.
   *
   * Registering a watcher while the socket is down is fine and expected — it is
   * re-armed on the next successful connect.
   */
  watch(url, query, variables, onData) {
    if (!WebSocket) return { close() {}, id: null };
    this._url = wsUrl(url);
    const id = String(this._nextId++);
    this._watchers.set(id, { query, variables, onData });
    this._wantOpen = true;
    if (this._connected) this._send({ id, type: "subscribe", payload: { query, variables } });
    else this._connect();
    return {
      id,
      close: () => {
        if (!this._watchers.delete(id)) return;
        if (this._connected) this._send({ id, type: "complete" });
        if (!this._watchers.size) this._shutdown();
      },
    };
  }

  // ── Connection ─────────────────────────────────────────────────────────────
  _connect() {
    if (!WebSocket || this._ws || !this._wantOpen || !this._url) return;
    let ws;
    try {
      ws = new WebSocket(this._url, SUBPROTOCOL, { handshakeTimeout: 15000 });
    } catch (err) {
      return this._scheduleReconnect(`connect failed: ${err.message}`);
    }
    this._ws = ws;

    ws.on("open", () => this._send({ type: "connection_init", payload: {} }));
    ws.on("message", (raw) => this._onMessage(raw));
    // 'error' always precedes 'close' on ws, so reconnect is driven from 'close'
    // alone to avoid scheduling it twice.
    ws.on("error", (err) => {
      if (this._connected || this._attempt === 0) {
        console.log(`⚠️  Overlay watch socket error: ${err.message}`);
      }
    });
    ws.on("close", (code) => {
      const wasConnected = this._connected;
      this._teardownSocket();
      if (this._wantOpen) this._scheduleReconnect(wasConnected ? `closed (${code})` : null);
    });
  }

  _onMessage(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {
      case "connection_ack":
        this._connected = true;
        this._attempt = 0;
        console.log(`🔌 Overlay watch connected (${this._watchers.size} subscription(s))`);
        // Re-arm every watcher: after a reconnect the server knows nothing.
        for (const [id, w] of this._watchers) {
          this._send({ id, type: "subscribe", payload: { query: w.query, variables: w.variables } });
        }
        this._startPings();
        this.emit("state", true);
        return;

      case "next": {
        const w = this._watchers.get(msg.id);
        if (w) {
          try { w.onData(msg.payload); }
          catch (err) { console.log(`⚠️  Overlay watch handler failed: ${err.message}`); }
        }
        return;
      }

      case "error":
        // A document-level error: this subscription will never produce data, so
        // drop it and let the caller's poll carry the overlay indefinitely.
        console.log(`⚠️  Overlay watch subscription rejected: ${JSON.stringify(msg.payload).slice(0, 300)}`);
        this._watchers.delete(msg.id);
        return;

      case "complete":
        this._watchers.delete(msg.id);
        return;

      case "ping":
        this._send({ type: "pong" });
        return;

      case "pong":
        if (this._pongTimer) { clearTimeout(this._pongTimer); this._pongTimer = null; }
        return;

      default:
        return;
    }
  }

  _send(obj) {
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return;
    try { this._ws.send(JSON.stringify(obj)); } catch (err) { /* close will follow */ }
  }

  _startPings() {
    this._stopPings();
    this._pingTimer = setInterval(() => {
      if (!this._connected) return;
      this._send({ type: "ping" });
      if (this._pongTimer) return;
      this._pongTimer = setTimeout(() => {
        this._pongTimer = null;
        console.log("⚠️  Overlay watch missed a pong — reconnecting");
        try { this._ws && this._ws.terminate(); } catch (e) { /* already gone */ }
      }, PONG_TIMEOUT_MS);
      if (this._pongTimer.unref) this._pongTimer.unref();
    }, PING_MS);
    if (this._pingTimer.unref) this._pingTimer.unref();
  }

  _stopPings() {
    if (this._pingTimer) { clearInterval(this._pingTimer); this._pingTimer = null; }
    if (this._pongTimer) { clearTimeout(this._pongTimer); this._pongTimer = null; }
  }

  _teardownSocket() {
    this._stopPings();
    const was = this._connected;
    this._connected = false;
    if (this._ws) {
      this._ws.removeAllListeners();
      try { this._ws.terminate(); } catch (e) { /* already gone */ }
      this._ws = null;
    }
    if (was) this.emit("state", false);
  }

  _scheduleReconnect(why) {
    if (this._reconnectTimer || !this._wantOpen) return;
    const backoff = Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * 2 ** this._attempt);
    const delay = Math.round(backoff * (0.5 + Math.random() / 2)); // jitter: do not
    this._attempt++;                                               // let a fleet
    if (why) console.log(`🔌 Overlay watch ${why} — reconnecting in ${Math.round(delay / 1000)}s`);
    this._reconnectTimer = setTimeout(() => {                      // reconnect in
      this._reconnectTimer = null;                                 // lockstep
      this._connect();
    }, delay);
    if (this._reconnectTimer.unref) this._reconnectTimer.unref();
  }

  _shutdown() {
    this._wantOpen = false;
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
    this._teardownSocket();
    this._attempt = 0;
  }

  /** For diagnostics via /api/overlay/engine. */
  stats() {
    return {
      available: !!WebSocket,
      connected: this._connected,
      subscriptions: this._watchers.size,
      reconnectAttempt: this._attempt,
    };
  }
}

// One socket per process: both cameras watch their own table over the same
// connection.
module.exports = new OverlayWatch();
