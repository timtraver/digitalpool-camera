/**
 * bleBridge.js — the Node half of BLE onboarding.
 *
 * ble/dp-ble.py owns the radio: GATT, advertising, pairing, chunking. It
 * forwards whole messages here over a unix socket and knows nothing about what
 * is in them. Everything that decides anything lives on this side, so the app
 * and the web UI go through the same code — wifiManager for networks, the same
 * registration path, the same subscription gate.
 *
 * See BLUETOOTH_ONBOARDING.md §4.3 for the socket protocol and §6 for the
 * message envelope.
 *
 * M1 implements the three commands that only read: `info`, `net.status` and
 * `wifi.scan`. Anything else answers UNKNOWN_COMMAND, and the app is expected
 * to feature-detect from `info.commands` rather than from a version number
 * (§6.5).
 */

const fs = require("fs");
const fsp = require("fs/promises");
const net = require("net");
const os = require("os");
const path = require("path");

const PROTO = 1;

/**
 * §5.1 — the name a phone shows in its list. The product name, not the
 * hostname: "dp-stream-b1b5" means nothing to somebody setting up their first
 * camera. The four hex digits are the last of the primary MAC, so they match
 * the hostname suffix, the hotspot SSID and the sticker on the box.
 * ble/dp-ble.py computes the same string for itself, for the window before
 * Node has connected.
 */
const BLE_NAME_PREFIX = "DP-DuoCast-";

/** §7.3 — the scopes that may change this camera's network. */
const GRANTED = ["claim", "manage"];

/** §5.2 advertisement state bits. */
const STATE = {
  REGISTERED: 1 << 0,
  INTERNET: 1 << 1,
  WIFI_CONFIGURED: 1 << 2,
  RECOVERY_WINDOW: 1 << 3,
  HOTSPOT: 1 << 4,
};

/** §7.4 — hotspot.start needs no grant for this long after a cold boot. */
const RECOVERY_WINDOW_SECONDS = 10 * 60;

/**
 * `auto` | `ble` | `hotspot` (§8.1). Under `ble` the camera never runs a
 * hotspot at all — see §2 D6, reversed on 2026-11-10.
 */
const ONBOARDING_MODE = (process.env.ONBOARDING_MODE || "auto").toLowerCase();

/** §5.3 — a phone holding the only connection and doing nothing. */
const IDLE_KICK_MS = 5 * 60 * 1000;

/**
 * A connection that has never sent a single request. One phone at a time (D8)
 * means a silent link makes the box invisible to everybody, so this one is
 * deliberately much shorter than the idle timeout: a real app sends `info`
 * within a second or two of subscribing, even allowing for pairing.
 */
const SILENT_KICK_MS = 60 * 1000;

/**
 * A connection that did useful work and then UNSUBSCRIBED from notifications,
 * without going away.
 *
 * That is what an iOS link looks like once the app has let go of it: iOS keeps
 * the LE link to a paired peripheral alive by itself, and on an N97 a live link
 * means the box cannot advertise at all — so it vanishes from everyone's list
 * until something terminates it. `session.end` handles the well-behaved case;
 * this catches an app that crashed or was force-quit without saying goodbye.
 *
 * Deliberately much shorter than the idle timeout, because nothing useful can
 * happen on a link with no way to reply.
 */
const UNSUBSCRIBED_KICK_MS = 30 * 1000;

/** After answering session.end, give the reply time to go out, then drop it. */
const SESSION_END_DROP_MS = 250;

/** How often to recompute the state bits and push them to the daemon. */
const ADV_REFRESH_MS = 15 * 1000;

/** A scan takes seconds; two at once just makes both slower. */
const SCAN_CACHE_MS = 10 * 1000;

class BleError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

class BleBridge {
  /**
   * @param {object} deps  everything from server.js this needs, passed in
   *   rather than required, so the bridge stays testable and server.js keeps
   *   being the only place that knows how the app is wired together.
   */
  constructor(deps = {}) {
    this.socketPath = deps.socketPath || "/run/digitalpool-camera/ble.sock";
    this.getDeviceName = deps.getDeviceName || (() => os.hostname());
    this.getPrimaryMac = deps.getPrimaryMac || (() => "");
    this.isRegistered = deps.isRegistered || (() => false);
    this.loadRemoteConfig = deps.loadRemoteConfig || (() => ({}));
    this.checkInternetCached = deps.checkInternetCached || (async () => false);
    this.wifiManager = deps.wifiManager || null;
    this.createHandoffToken = deps.createHandoffToken || null;
    this.registerWith = deps.registerWith || null;
    this.removeRegistration = deps.removeRegistration || null;
    this.looksLikeIdToken = deps.looksLikeIdToken || (() => false);
    this.getDisplayName = deps.getDisplayName || (() => "");
    this.log = deps.log || ((...a) => console.log("[ble]", ...a));

    this.server = null;
    this.daemon = null;        // the one socket dp-ble.py connects on
    this.daemonBuf = "";
    this.connections = new Map(); // conn id -> { at, lastActivity, scope, nonce, busy }
    this.lastBits = null;
    this.lastName = null;
    this.timers = [];
    this.scanCache = { at: 0, networks: null, inflight: null };

    /**
     * The command table. `scope` is unused in M1 — every command here is
     * readable without a grant per §7.3 — but it is the shape M3 fills in, so
     * adding a privileged command later is a one-line change rather than a
     * refactor.
     */
    this.commands = {
      "info":        { scopes: null, handler: () => this.cmdInfo() },
      "net.status":  { scopes: null, handler: () => this.cmdNetStatus() },
      "wifi.scan":   { scopes: null, handler: () => this.cmdWifiScan() },
      "wifi.saved":  { scopes: GRANTED, handler: () => this.cmdWifiSaved() },
      "wifi.connect":{ scopes: GRANTED, handler: (a, c) => this.cmdWifiConnect(a, c) },
      "wifi.forget": { scopes: GRANTED, handler: (a) => this.cmdWifiForget(a) },
      "wifi.disconnect": { scopes: GRANTED, handler: () => this.cmdWifiDisconnect() },
      "web.link":    { scopes: GRANTED, handler: () => this.cmdWebLink() },
      // §10 step 4. No grant and no BLE_DEV_NO_AUTH: the Firebase ID token the
      // app sends IS the authentication, and the backend is what verifies it
      // (admin.auth().verifyIdToken). Nothing the box could check would add
      // anything — it has no Firebase SDK and no key.
      "register.start":  { scopes: null, handler: (a, c) => this.cmdRegisterStart(a, c) },
      "register.venue":  { scopes: null, handler: (a, c) => this.cmdRegisterVenue(a, c) },
      "register.status": { scopes: null, handler: () => this.cmdRegisterStatus() },
      "register.remove": { scopes: null, handler: (a) => this.cmdRegisterRemove(a) },
      "session.end":     { scopes: null, handler: (a, c) => this.cmdSessionEnd(c) },
    };

    /**
     * §7.3 says the commands that change the network need a signed grant, and
     * grants are M3. Until then there is nothing to check, so this flag is the
     * only thing standing between a stranger in the car park and this camera's
     * network settings. It must never be set on a shipped box — the same rule
     * as BLE_ACCEPT_DEV_GRANTS in §11.3 — and dp-create-image.sh should refuse
     * to capture a device that has it.
     */
    this.allowUnauthenticated = process.env.BLE_DEV_NO_AUTH === "1";
    if (this.allowUnauthenticated) {
      this.log("!!! BLE_DEV_NO_AUTH=1 — anyone in radio range can change this camera's network");
    }

    /**
     * The outcome of the most recent wifi.connect, so a phone that lost its
     * BLE link mid-connect can reconnect and find out what happened (§10).
     */
    this.lastConnect = null;
    this.connecting = false;

    /**
     * The outcome of the most recent registration attempt, so a phone that
     * lost its link mid-registration can reconnect and read how it ended
     * rather than starting again — NetBird alone can take 90 s, which is a
     * long time to hold a BLE link on a box whose radio is busy.
     */
    this.lastRegister = null;
    this.registering = false;

    /**
     * Can this controller advertise while a phone is connected?
     *
     * The N100's Intel can; the N97's Realtek cannot, and on those a held link
     * makes the box invisible to every phone including the one holding it.
     * The app reads this to decide whether keeping the link open while the web
     * UI is on screen is free or costly. Optimistic until the daemon learns
     * otherwise, which it does within ~1.5 s of the first connection.
     */
    this.advertisesWhileConnected = true;
  }

  // ── lifecycle ──────────────────────────────────────────────────────────

  async start() {
    const dir = path.dirname(this.socketPath);
    try {
      await fsp.mkdir(dir, { recursive: true });
    } catch (err) {
      this.log(`cannot create ${dir}: ${err.message}`);
      return false;
    }

    // A socket left behind by a crash would make bind() fail with EADDRINUSE
    // forever. Nothing else owns this path, so removing it is safe.
    try {
      await fsp.unlink(this.socketPath);
    } catch (err) {
      if (err.code !== "ENOENT") {
        this.log(`cannot clear stale socket: ${err.message}`);
      }
    }

    this.server = net.createServer((socket) => this._onDaemonConnect(socket));
    this.server.on("error", (err) => this.log(`socket server error: ${err.message}`));

    await new Promise((resolve) => this.server.listen(this.socketPath, resolve));
    // Both processes run as `dp`; the RuntimeDirectory is 0700, so this is
    // belt and braces rather than the thing keeping anyone out.
    try {
      fs.chmodSync(this.socketPath, 0o600);
    } catch { /* not fatal */ }

    this.timers.push(setInterval(() => this._pushAdvState(), ADV_REFRESH_MS));
    this.timers.push(setInterval(() => this._kickIdle(), 30 * 1000));
    this.log(`listening on ${this.socketPath}`);
    return true;
  }

  stop() {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    if (this.daemon) {
      try { this.daemon.destroy(); } catch { /* ignore */ }
      this.daemon = null;
    }
    if (this.server) {
      try { this.server.close(); } catch { /* ignore */ }
      this.server = null;
    }
    try { fs.unlinkSync(this.socketPath); } catch { /* ignore */ }
  }

  // ── the daemon connection ──────────────────────────────────────────────

  _onDaemonConnect(socket) {
    // Only one daemon. A second connection means the old one died without the
    // socket closing; the new one wins.
    if (this.daemon) {
      this.log("a second daemon connected — dropping the first");
      try { this.daemon.destroy(); } catch { /* ignore */ }
    }
    this.daemon = socket;
    this.daemonBuf = "";
    socket.setEncoding("utf8");

    socket.on("data", (chunk) => {
      this.daemonBuf += chunk;
      let index;
      while ((index = this.daemonBuf.indexOf("\n")) >= 0) {
        const line = this.daemonBuf.slice(0, index).trim();
        this.daemonBuf = this.daemonBuf.slice(index + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch (err) {
          this.log(`bad line from the daemon: ${err.message}`);
          continue;
        }
        this._onDaemonMessage(msg).catch((err) =>
          this.log(`handler threw: ${err.stack || err.message}`)
        );
      }
    });

    const drop = () => {
      if (this.daemon === socket) {
        this.daemon = null;
        this.connections.clear();
        this.log("daemon disconnected");
      }
    };
    socket.on("close", drop);
    socket.on("error", (err) => {
      this.log(`daemon socket error: ${err.message}`);
      drop();
    });
  }

  async _onDaemonMessage(msg) {
    switch (msg.t) {
      case "hello":
        if (typeof msg.advertisesWhileConnected === "boolean") {
          this.advertisesWhileConnected = msg.advertisesWhileConnected;
        }
        this.log(`daemon up: proto ${msg.proto}, ${msg.adapter} (${msg.address})`);
        this.lastBits = null; // force a push so it starts with the truth
        await this._pushAdvState();
        break;

      case "connect":
        this.connections.set(msg.conn, {
          at: Date.now(),
          lastActivity: Date.now(),
          sawRequest: false,
          subscribed: false,
          unsubscribedAt: 0,
          scope: null,
          nonce: null,
          busy: new Set(),
        });
        this.log(`phone connected (${msg.conn})`);
        break;

      case "disconnect":
        this.connections.delete(msg.conn);
        this.log(`phone disconnected (${msg.conn})`);
        break;

      case "notify": {
        const state = this.connections.get(msg.conn);
        if (state) {
          state.subscribed = !!msg.on;
          state.unsubscribedAt = msg.on ? 0 : Date.now();
        }
        break;
      }

      case "caps":
        if (typeof msg.advertisesWhileConnected === "boolean") {
          this.advertisesWhileConnected = msg.advertisesWhileConnected;
          this.log(`controller advertises while connected: ${msg.advertisesWhileConnected}`);
        }
        break;

      case "msg":
        await this._onRequest(msg.conn, msg.data);
        break;

      default:
        this.log(`unknown message from the daemon: ${msg.t}`);
    }
  }

  _send(conn, data) {
    if (!this.daemon) return;
    try {
      this.daemon.write(JSON.stringify({ t: "send", conn, data }) + "\n");
    } catch (err) {
      this.log(`could not write to the daemon: ${err.message}`);
    }
  }

  /** Unprompted event to the phone (§6.3). */
  emit(conn, event, data) {
    this._send(conn, { event, data });
  }

  kick(conn) {
    if (!this.daemon) return;
    try {
      this.daemon.write(JSON.stringify({ t: "kick", conn }) + "\n");
    } catch { /* ignore */ }
  }

  // ── request dispatch ───────────────────────────────────────────────────

  async _onRequest(conn, request) {
    const state = this.connections.get(conn);
    if (state) {
      state.lastActivity = Date.now();
      state.sawRequest = true;
    }

    const id = request && typeof request.id !== "undefined" ? request.id : null;
    const name = request && request.cmd;

    const reply = (payload) => this._send(conn, { ...payload, ...(id !== null ? { id } : {}) });
    const fail = (code, message) => {
      // Every refusal is logged, with the command and the CODE only — never
      // the arguments, which carry ID tokens and WiFi passwords. Without this
      // a rejected request left no trace at all: on the first Android test the
      // box refused something and the journal showed only a connection that
      // did nothing, which is indistinguishable from the request never
      // arriving. The code is what tells those two apart.
      this.log(`refused ${name || "(no command)"}: ${code}`);
      return reply({ ok: false, error: { code, message } });
    };

    if (!name || typeof name !== "string") {
      this.log("refused a request with no command");
      return reply({ ok: false, error: { code: "BAD_REQUEST", message: "No command given" } });
    }

    const entry = this.commands[name];
    if (!entry) {
      return fail("UNKNOWN_COMMAND", `This camera does not support "${name}"`);
    }

    // §7.3
    if (!this._scopeSatisfied(entry, state)) {
      return fail("NOT_AUTHORIZED", "Sign in to this camera from the app first");
    }

    // §6.4 BUSY: the same command twice at once on one connection.
    if (state && state.busy.has(name)) {
      return fail("BUSY", `"${name}" is already running`);
    }
    if (state) state.busy.add(name);

    try {
      const result = await entry.handler(request.args || {}, conn);
      reply({ ok: true, result });
      // Only the commands that change something, so the journal stays
      // readable while still showing what a session actually did.
      if (name !== "info" && name !== "net.status") this.log(`${name} ok`);
    } catch (err) {
      if (err instanceof BleError) {
        fail(err.code, err.message);
      } else {
        this.log(`${name} failed: ${err.stack || err.message}`);
        fail("INTERNAL", "Something went wrong on the camera");
      }
    } finally {
      if (state) state.busy.delete(name);
    }
  }

  /**
   * Does this connection hold a scope the command accepts?
   *
   * Grants arrive in M3. Until they do, `allowUnauthenticated` is what decides,
   * and it defaults to refusing — a camera that let any passer-by retarget its
   * WiFi is worse than one that cannot be set up yet.
   */
  _scopeSatisfied(entry, state) {
    if (!entry.scopes) return true;
    if (state && state.scope && entry.scopes.includes(state.scope)) return true;
    return this.allowUnauthenticated;
  }

  /**
   * The app is leaving and wants the box to drop the link.
   *
   * iOS keeps an LE link to a paired peripheral up after the app has
   * cancelled its side; a peripheral-initiated disconnect is the only thing
   * it cannot override. On an N97 that is the difference between the box
   * being discoverable and vanishing for five minutes.
   *
   * The reply goes first and the drop follows a beat later, so the app gets
   * its answer rather than a dead link.
   */
  async cmdSessionEnd(conn) {
    this.log(`session.end — dropping the link for ${conn}`);
    setTimeout(() => this.kick(conn), SESSION_END_DROP_MS);
    return { ending: true };
  }

  _kickIdle() {
    const now = Date.now();
    for (const [conn, state] of this.connections) {
      // A link that has never said anything is almost always an orphan: a
      // phone whose app-side session died, or one that connected and
      // backgrounded. It costs everybody else access to the box.
      if (!state.sawRequest && now - state.at >= SILENT_KICK_MS) {
        this.log(`kicking ${conn} — connected ${Math.round((now - state.at) / 1000)}s and never sent a request`);
        this.kick(conn);
        continue;
      }
      // Did work, then unsubscribed, and is still here: almost always iOS
      // holding a link the app has finished with.
      if (state.sawRequest && !state.subscribed && state.unsubscribedAt
          && now - state.unsubscribedAt >= UNSUBSCRIBED_KICK_MS) {
        this.log(`kicking ${conn} — unsubscribed ${Math.round((now - state.unsubscribedAt) / 1000)}s ago and still connected`);
        this.kick(conn);
        continue;
      }

      if (now - state.lastActivity < IDLE_KICK_MS) continue;
      // Whatever was started stays running — the app reads the result from
      // net.status after reconnecting (§5.3).
      this.log(`kicking idle connection ${conn}`);
      this.kick(conn);
    }
  }

  // ── state the advertisement carries ────────────────────────────────────

  /**
   * §7.4's recovery window existed for exactly one purpose: letting
   * `hotspot.start` run without a grant, so an owner whose phone had no
   * internet could still get a hotspot up at a venue whose WiFi had changed.
   *
   * Under `ble` the camera never runs a hotspot (§2 D6), so there is nothing
   * for the window to permit, and reporting it would have the app offering a
   * recovery route that does not exist. Bluetooth is the recovery route now,
   * and it needs no window: it works with no network at all.
   */
  _inRecoveryWindow() {
    if (ONBOARDING_MODE === "ble") return false;
    return os.uptime() < RECOVERY_WINDOW_SECONDS;
  }

  async _computeBits() {
    let bits = 0;
    if (this.isRegistered()) bits |= STATE.REGISTERED;
    if (await this.checkInternetCached()) bits |= STATE.INTERNET;
    if (this._inRecoveryWindow()) bits |= STATE.RECOVERY_WINDOW;

    if (this.wifiManager) {
      try {
        const client = await this.wifiManager.getClientWifiStatus();
        if (client && client.available && client.ssid) bits |= STATE.WIFI_CONFIGURED;
      } catch { /* leave the bit clear */ }
      // Always 0 under `ble`. wifiManager never brings the AP up in that mode,
      // but read the real state rather than assuming it — a box mid-switch, or
      // one whose hotspot somebody started by hand, should say so.
      if (this.wifiManager.apRunning) bits |= STATE.HOTSPOT;
    }
    return bits;
  }

  /**
   * Push the state bits and the device name down to the daemon when either
   * changes, so the app's device list is useful before anyone connects (§5.2).
   */
  async _pushAdvState() {
    if (!this.daemon) return;
    let bits;
    try {
      bits = await this._computeBits();
    } catch (err) {
      this.log(`could not compute state bits: ${err.message}`);
      return;
    }
    const name = this.bleName();
    if (bits === this.lastBits && name === this.lastName) return;
    this.lastBits = bits;
    this.lastName = name;
    try {
      this.daemon.write(JSON.stringify({ t: "adv", state: { bits, name } }) + "\n");
    } catch (err) {
      this.log(`could not push advertisement state: ${err.message}`);
    }
  }

  // ── commands ───────────────────────────────────────────────────────────

  /**
   * Everything the app needs to decide what to show, and nothing a stranger
   * should not have. `info` takes no grant (§7.3), so anyone within ~30 m can
   * read this: it says whether the box is registered, but deliberately not to
   * whom. The owner's email comes from the grant the app already holds, not
   * from the box.
   */
  async cmdInfo() {
    const cfg = this.loadRemoteConfig() || {};
    const mac = this.getPrimaryMac();
    const registered = this.isRegistered();
    return {
      proto: PROTO,
      commands: Object.keys(this.commands),
      // Two names on purpose: `bleName` is what the phone saw in its list and
      // what is printed on the box, `name` is what the web UI, NetBird and the
      // DigitalPool backend call it. They share the last four hex digits.
      name: this.getDeviceName(),
      bleName: this.bleName(),
      mac,
      shortId: mac ? mac.replace(/:/g, "").slice(-4) : "",
      model: this._boardModel(),
      version: this._appVersion(),
      registered,
      venue: registered && cfg.venueName
        ? { id: cfg.venueId || "", name: cfg.venueName }
        : null,
      onboardingMode: process.env.ONBOARDING_MODE || "auto",
      // False on the N97: a held link makes the box undiscoverable, so the app
      // should drop the link while the web UI is open rather than keep it.
      advertisesWhileConnected: this.advertisesWhileConnected,
      recoveryWindow: this._inRecoveryWindow(),
      registering: this.registering,
    };
  }

  /**
   * What the app needs for "is this box online, and over what?" — the question
   * that decides whether the network step is shown at all (§10 step 3).
   */
  async cmdNetStatus() {
    const ethernet = this._ethernetStatus();
    let wifi = { available: false };
    let hotspot = { active: false };

    if (this.wifiManager) {
      try {
        wifi = await this.wifiManager.getClientWifiStatus();
      } catch (err) {
        wifi = { available: false, reason: err.message };
      }
      try {
        const status = await this.wifiManager.getStatus();
        hotspot = {
          active: !!status.apRunning,
          ssid: status.apSsid || null,
          ip: status.apIp || null,
        };
      } catch { /* leave it inactive */ }
    }

    const internet = await this.checkInternetCached();
    return {
      internet,
      // How the last join attempt ended, for a phone that reconnected after
      // losing its link partway through one.
      lastConnect: this.lastConnect,
      connecting: this.connecting,
      // Ethernet keeps its NetworkManager route metric advantage over WiFi,
      // so when both are up this is the one carrying traffic (§8.2).
      preferred: ethernet.up ? "ethernet" : (wifi.state === "connected" ? "wifi" : null),
      ethernet,
      wifi,
      hotspot,
    };
  }

  /**
   * The venue's networks, newest scan or a cached one (§6.3).
   *
   * An empty list carries a `reason`, because "no networks" and "this radio
   * cannot scan right now" look identical to the app otherwise, and the second
   * is the common one: an active rescan needs a managed interface, and a box
   * whose only radio is running the hotspot has none. Showing a user an empty
   * list in a bar full of WiFi is how a setup flow loses somebody's trust.
   */
  async cmdWifiScan() {
    if (!this.wifiManager) {
      throw new BleError("INTERNAL", "No WiFi manager on this device");
    }
    const now = Date.now();
    if (this.scanCache.networks && now - this.scanCache.at < SCAN_CACHE_MS) {
      return this._scanResult(this.scanCache.networks, true);
    }
    // Two phones (or one impatient one) asking at the same time share a scan
    // rather than queueing two rescans behind each other.
    if (!this.scanCache.inflight) {
      this.scanCache.inflight = this.wifiManager
        .scanNetworks()
        .then((networks) => {
          this.scanCache = { at: Date.now(), networks, inflight: null };
          return networks;
        })
        .catch((err) => {
          this.scanCache.inflight = null;
          throw err;
        });
    }
    const networks = await this.scanCache.inflight;
    return this._scanResult(networks, false);
  }

  /** Wrap a scan result, explaining an empty one. */
  async _scanResult(networks, cached) {
    const result = { networks, cached };
    if (networks.length > 0) return result;

    if (!this.wifiManager.wifiIface) {
      result.reason = "NO_WIFI_ADAPTER";
      result.message = "This camera has no WiFi adapter. Use Ethernet.";
      return result;
    }
    let client = null;
    try {
      client = await this.wifiManager.getClientWifiStatus();
    } catch { /* treated as absent below */ }
    if ((!client || !client.available) && this.wifiManager.apRunning) {
      // One radio, and the hotspot is on it. Scanning needs a managed
      // interface; the AP interface can only hand back a stale cache, which on
      // a box that has never scanned is empty.
      result.reason = "HOTSPOT_OWNS_RADIO";
      result.message =
        "The camera's WiFi is running its setup hotspot, so it cannot scan. " +
        "Turn the hotspot off, or plug in a USB WiFi adapter.";
      return result;
    }
    result.reason = "NO_NETWORKS_FOUND";
    result.message = "No WiFi networks are in range.";
    return result;
  }

  /** Networks this camera already knows, so the app can offer them first. */
  async cmdWifiSaved() {
    if (!this.wifiManager) throw new BleError("INTERNAL", "No WiFi manager on this device");
    return { networks: await this.wifiManager.savedNetworks() };
  }

  /**
   * Leave the current network without forgetting it.
   *
   * `stillOnline` is false when the camera had no wired connection, which
   * means this command just took it off the internet — worth the app saying so
   * before the user taps it, not after.
   */
  async cmdWifiDisconnect() {
    if (!this.wifiManager) throw new BleError("INTERNAL", "No WiFi manager on this device");
    const result = await this.wifiManager.disconnectFromNetwork();
    if (!result.success) throw new BleError("WIFI_FAILED", result.error);
    this.lastBits = null;
    this._pushAdvState().catch(() => {});
    return { disconnected: result.ssid, profile: result.profile, stillOnline: result.stillOnline };
  }

  /** Forget a saved network. */
  async cmdWifiForget(args) {
    if (!this.wifiManager) throw new BleError("INTERNAL", "No WiFi manager on this device");
    const ssid = args && args.ssid;
    if (typeof ssid !== "string" || !ssid) {
      throw new BleError("BAD_REQUEST", "Which network should the camera forget?");
    }
    const result = await this.wifiManager.forgetNetwork(ssid);
    if (!result.success) throw new BleError("WIFI_FAILED", result.error);
    return { forgotten: ssid };
  }

  /**
   * Join a WiFi network.
   *
   * Returns `{ accepted: true }` straight away and does the work in the
   * background, because joining a network takes up to 45 s and the BLE link is
   * the first thing to suffer when the radio is busy (§10). Progress arrives
   * as `wifi.progress` events; the final outcome is also kept in
   * `net.status.lastConnect`, so a phone whose link dropped mid-attempt can
   * reconnect and find out how it ended rather than starting over.
   */
  async cmdWifiConnect(args, conn) {
    if (!this.wifiManager) throw new BleError("INTERNAL", "No WiFi manager on this device");

    const ssid = args && args.ssid;
    const psk = args && (args.psk || args.password);
    const hidden = !!(args && args.hidden);

    if (typeof ssid !== "string" || !ssid) {
      throw new BleError("BAD_REQUEST", "Which network should the camera join?");
    }
    if (psk !== undefined && psk !== null && typeof psk !== "string") {
      throw new BleError("BAD_REQUEST", "The password must be text");
    }
    // One at a time. Two attempts would fight over the same radio and the
    // second would tear down the first halfway through.
    if (this.connecting) {
      throw new BleError("BUSY", "The camera is already joining a network");
    }

    this.connecting = true;
    this.lastConnect = { ssid, stage: "associating", at: Date.now(), done: false };

    const onProgress = (stage, detail) => {
      this.lastConnect = { ...this.lastConnect, stage, ...detail, at: Date.now() };
      // The phone may well have dropped — a one-radio box loses the venue
      // network and the BLE link gets noisy while the radio retunes. Events
      // are best-effort; lastConnect is the durable answer.
      this.emit(conn, "wifi.progress", { ssid, stage, ...detail });
    };

    // Deliberately not awaited: the reply goes out now.
    this.wifiManager
      .connectToNetwork(ssid, psk || "", { hidden, security: args && args.security, onProgress })
      .then((result) => {
        this.lastConnect = {
          ...this.lastConnect,
          done: true,
          success: result.success,
          code: result.code || null,
          message: result.error || result.message || null,
          internet: !!result.internet,
          at: Date.now(),
        };
        this.emit(conn, "wifi.result", this.lastConnect);
        this.log(
          result.success
            ? `joined "${ssid}"${result.internet ? "" : " (no internet)"}`
            : `could not join "${ssid}": ${result.code} ${result.error}`
        );
        // The network changed, so the advertised state bits did too.
        this.lastBits = null;
        this._pushAdvState().catch(() => {});
      })
      .catch((err) => {
        // The app waits for a final stage and gives up after 75 s. A throw in
        // here must still produce one, or the only thing the user sees is a
        // spinner that eventually times out with the wrong reason.
        this.lastConnect = {
          ...this.lastConnect, done: true, success: false, stage: "failed",
          code: "WIFI_FAILED", message: err.message, at: Date.now(),
        };
        this.emit(conn, "wifi.progress", {
          ssid, stage: "failed", code: "WIFI_FAILED", message: err.message,
        });
        this.emit(conn, "wifi.result", this.lastConnect);
        this.log(`wifi.connect threw: ${err.stack || err.message}`);
      })
      .finally(() => { this.connecting = false; });

    return { accepted: true, ssid };
  }

  /**
   * A one-time link that opens the web UI already signed in (§9.2).
   *
   * The app has the user's identity already, over an encrypted link it had to
   * pair to establish. Asking them to then type `admin` / `Digitalpool` into a
   * phone keyboard is both worse security and worse to use.
   *
   * The token is minted by server.js, lives in memory for 120 s and works
   * once. Note what this command does NOT do: it never returns the token on
   * its own, only inside a URL bound to an address the phone can actually
   * reach, so there is nothing useful to copy out of a log.
   */
  async cmdWebLink() {
    if (!this.createHandoffToken) {
      throw new BleError("INTERNAL", "This camera cannot issue login links");
    }

    const port = process.env.PORT || 3000;
    const urls = [];

    // The LAN address the box is actually routing over. Offering an address on
    // an interface that is down gives the app a link that times out, and the
    // user a spinner with no explanation.
    const ethernet = this._ethernetStatus();
    let lanIp = ethernet.up ? ethernet.ip : null;
    if (!lanIp && this.wifiManager) {
      try {
        const wifi = await this.wifiManager.getClientWifiStatus();
        if (wifi && wifi.state === "connected" && wifi.ip) lanIp = wifi.ip;
      } catch { /* no LAN address to offer */ }
    }

    let hotspotIp = null;
    if (this.wifiManager) {
      try {
        const status = await this.wifiManager.getStatus();
        if (status.apRunning) hotspotIp = status.apIp;
      } catch { /* hotspot not up */ }
    }

    if (!lanIp && !hotspotIp) {
      throw new BleError(
        "NO_INTERNET",
        "The camera is not on a network yet, so there is nothing to open. Connect it to WiFi first."
      );
    }

    // One token covers every URL in this response: they are the same login
    // offered over whichever path the phone can reach, and only one of them
    // will ever be opened.
    const { token, expiresIn } = this.createHandoffToken({
      username: "app",
      displayName: "DigitalPool app",
    });

    if (lanIp) {
      urls.push({ kind: "lan", url: `http://${lanIp}:${port}/auth/handoff?t=${token}` });
    }
    if (hotspotIp) {
      urls.push({ kind: "hotspot", url: `http://${hotspotIp}:${port}/auth/handoff?t=${token}` });
    }

    this.log(`issued a one-time login link (${urls.map(u => u.kind).join(", ")})`);
    return { urls, expiresIn };
  }

  /**
   * Register this camera to the signed-in app user (§10 step 4).
   *
   * The app sends the Firebase ID token of whoever is signed in, and the box
   * hands it straight to `registerCameraDevice`, which verifies it. No
   * password is typed into a phone, and the box keeps nothing: the token is
   * used for the call and dropped. What persists is the `userId` and
   * `ownerEmail` the backend returns, which is what the recurring
   * subscription check is keyed by.
   *
   * **The token is never logged.** Not in the journal, not in an error, not
   * in `register.status`. It is a bearer credential for that person's whole
   * DigitalPool account for up to an hour, and a camera's journal is read by
   * support.
   */
  async cmdRegisterStart(args, conn) {
    // The app always picks the venue (Tim, 2026-11-11), so this never
    // registers on its own — its final event is always chooseVenue, even for
    // an account with exactly one venue, or none. An empty list is a usable
    // answer because the app offers "Create a new venue".
    return this._beginRegistration(args, conn, { alwaysChooseVenue: true });
  }

  /**
   * The venue picker's answer: either an existing venue, or a new one to
   * create (§10 step 4).
   *
   *   { idToken, venueId: 123 }
   *   { idToken, newVenue: { name: "Corner Pocket", city: "Denver" } }
   *
   * The backend creates a private venue owned by the user, and reuses one it
   * already owns with the same name, so retrying after a dropped BLE link
   * does not leave a trail of duplicate venues.
   */
  async cmdRegisterVenue(args, conn) {
    const venueId = args && args.venueId;
    const newVenue = args && args.newVenue;
    const haveVenueId = venueId !== undefined && venueId !== null && venueId !== "";

    if (!haveVenueId && !newVenue) {
      throw new BleError("BAD_REQUEST", "Which venue should the camera belong to?");
    }
    if (haveVenueId && newVenue) {
      // Ambiguous, and the backend would have to guess. Better to say so.
      throw new BleError("BAD_REQUEST", "Choose an existing venue or create one, not both");
    }

    // The table is optional on every path: with neither, the backend picks the
    // venue's first table or creates "Table 1", which is what the web setup
    // page has always relied on.
    const table = this._validateTableChoice(args);

    if (newVenue) {
      const name = newVenue.name;
      const city = newVenue.city;
      // Light validation only — the backend owns the real rules. This is here
      // so obvious rubbish does not make a round trip, and because the value
      // arrives over Bluetooth.
      if (typeof name !== "string" || name.trim().length === 0) {
        throw new BleError("BAD_REQUEST", "The new venue needs a name");
      }
      if (name.length > 100) {
        throw new BleError("BAD_REQUEST", "That venue name is too long (max 100 characters)");
      }
      if (city !== undefined && city !== null
          && (typeof city !== "string" || city.length > 100)) {
        throw new BleError("BAD_REQUEST", "That city name is too long (max 100 characters)");
      }
      return this._beginRegistration(args, conn, {
        newVenue: {
          name: name.trim(),
          ...(typeof city === "string" && city.trim() ? { city: city.trim() } : {}),
        },
        ...table,
      });
    }

    return this._beginRegistration(args, conn, {
      venueId,
      venueName: (args && args.venueName) || "",
      venueSlug: (args && args.venueSlug) || "",
      ...table,
    });
  }

  /**
   * Which table, if the app named one. Returns {} , { tableId } or
   * { newTable }, or throws BAD_REQUEST.
   */
  _validateTableChoice(args) {
    const tableId = args && args.tableId;
    const newTable = args && args.newTable;
    const haveTableId = tableId !== undefined && tableId !== null && tableId !== "";

    if (haveTableId && newTable) {
      throw new BleError("BAD_REQUEST", "Choose an existing table or create one, not both");
    }
    if (haveTableId) {
      // A number or a numeric string, echoed as given so the backend sees
      // exactly what the app chose from its own list. It must be a POSITIVE
      // INTEGER: Number.isFinite() accepts -3 and 1.5, and letting those
      // through means the box starts a registration that the backend then has
      // to reject, after NetBird has been brought up for it.
      const positiveInteger = typeof tableId === "number"
        ? Number.isInteger(tableId) && tableId > 0
        // Leading zeros are allowed through ("007"): if the app ever zero-pads,
        // a BAD_REQUEST the user cannot act on is worse than letting the
        // backend answer with something specific about the table.
        : /^0*[1-9]\d*$/.test(String(tableId).trim());
      if (!positiveInteger) {
        throw new BleError("BAD_REQUEST", "That table id is not valid");
      }
      return { tableId };
    }
    if (newTable) {
      const label = newTable.label;
      if (typeof label !== "string" || label.trim().length === 0) {
        throw new BleError("BAD_REQUEST", "The new table needs a name");
      }
      if (label.trim().length > 50) {
        throw new BleError("BAD_REQUEST", "That table name is too long (max 50 characters)");
      }
      return { newTable: { label: label.trim() } };
    }
    return {};
  }

  /**
   * Remove this camera's registration (§9.6).
   *
   * Unlike register.start this does NOT return early — the app waits for the
   * real answer, because "removed" has to mean the venue no longer has the
   * box AND this box no longer thinks it belongs to one. Splitting that across
   * an accepted-then-events flow would let the two disagree. The wipe includes
   * tearing NetBird down, so it can take a few seconds; the app allows 60.
   *
   * No grant and no BLE_DEV_NO_AUTH: the token is the authentication, and the
   * backend decides whether this person may remove this box.
   */
  async cmdRegisterRemove(args) {
    if (!this.removeRegistration) {
      throw new BleError("INTERNAL", "This camera cannot remove its own registration");
    }
    if (!this.isRegistered()) {
      throw new BleError("NOT_REGISTERED", "This camera is not registered.");
    }
    const idToken = args && args.idToken;
    if (!this.looksLikeIdToken(idToken)) {
      throw new BleError("BAD_REQUEST", "A valid sign-in token is required");
    }
    if (!(await this.checkInternetCached({ fresh: true }))) {
      throw new BleError("NO_INTERNET",
        "The camera has no internet connection, so it cannot be removed from the venue.");
    }

    const result = await this.removeRegistration(idToken);
    if (!result.ok) throw new BleError(result.code, result.message);

    this.lastRegister = null;
    this.lastBits = null;
    await this._pushAdvState().catch(() => {});
    this.log("registration removed at the app's request");
    return { removed: true };
  }

  /** How the last registration attempt ended, for a phone that reconnected. */
  async cmdRegisterStatus() {
    return this.lastRegister || { stage: null, done: false };
  }

  async _beginRegistration(args, conn, options) {
    if (!this.registerWith) {
      throw new BleError("INTERNAL", "This camera cannot register itself");
    }
    if (this.isRegistered()) {
      throw new BleError("ALREADY_REGISTERED",
        "This camera is already registered. Remove it from its venue first.");
    }
    if (this.registering) {
      throw new BleError("BUSY", "This camera is already registering");
    }

    const idToken = args && args.idToken;
    if (!this.looksLikeIdToken(idToken)) {
      // Deliberately says nothing about the value itself.
      throw new BleError("BAD_REQUEST", "A valid sign-in token is required");
    }
    if (!(await this.checkInternetCached({ fresh: true }))) {
      throw new BleError("NO_INTERNET",
        "The camera has no internet connection yet. Connect it to WiFi first.");
    }

    this.registering = true;
    this.lastRegister = { stage: "netbird", done: false, at: Date.now() };

    const emit = (stage, data = {}) => {
      this.lastRegister = { ...this.lastRegister, stage, ...data, at: Date.now() };
      this.emit(conn, "register.progress", { stage, ...data });
    };

    // Not awaited: the reply goes out now. NetBird alone can take 90 s.
    this.registerWith({ idToken }, { ...options, onProgress: (stage) => emit(stage) })
      .then((result) => {
        switch (result.state) {
          case "registered":
            this.lastRegister = {
              stage: "registered", done: true, success: true,
              venue: result.venue, table: result.table || null, at: Date.now(),
            };
            this.emit(conn, "register.progress", {
              stage: "registered", venue: result.venue, table: result.table || null,
            });
            this.log(`registered to venue ${result.venue.name || result.venue.id}`
                   + `${result.table?.label ? `, ${result.table.label}` : ""}`);
            break;
          case "chooseVenue":
            this.lastRegister = {
              stage: "chooseVenue", done: true, success: false,
              venues: result.venues, assignedVenueId: result.assignedVenueId, at: Date.now(),
            };
            this.emit(conn, "register.progress", {
              stage: "chooseVenue", venues: result.venues,
              assignedVenueId: result.assignedVenueId,
            });
            break;
          case "needVenue":
            this.lastRegister = { stage: "needVenue", done: true, success: false, at: Date.now() };
            this.emit(conn, "register.progress", { stage: "needVenue" });
            break;
          default:
            this.lastRegister = {
              stage: "failed", done: true, success: false,
              code: result.code, message: result.message, url: result.url || null,
              at: Date.now(),
            };
            this.emit(conn, "register.progress", {
              stage: "failed", code: result.code, message: result.message,
              ...(result.url ? { url: result.url } : {}),
            });
            this.log(`registration refused: ${result.code} ${result.message}`);
        }
        // Registered or not, the advertised state bits may have moved.
        this.lastBits = null;
        this._pushAdvState().catch(() => {});
      })
      .catch((err) => {
        // The app waits for exactly one final event; a throw must still
        // produce one. The message is ours, not the exception's, because an
        // exception from the registration path could quote the request.
        this.lastRegister = {
          stage: "failed", done: true, success: false,
          code: "REGISTRATION_FAILED", message: "The camera could not complete registration.",
          at: Date.now(),
        };
        this.emit(conn, "register.progress", {
          stage: "failed", code: "REGISTRATION_FAILED",
          message: "The camera could not complete registration.",
        });
        this.log(`register threw: ${err.message}`);
      })
      .finally(() => { this.registering = false; });

    return { accepted: true };
  }

  // ── small helpers ──────────────────────────────────────────────────────

  /** The advertised BLE name: DP-DuoCast-XXXX (§5.1). */
  bleName() {
    const mac = this.getPrimaryMac();
    const suffix = mac ? mac.replace(/:/g, "").slice(-4).toUpperCase() : "0000";
    return `${BLE_NAME_PREFIX}${suffix}`.slice(0, 20);
  }

  _ethernetStatus() {
    const NET_DIR = "/sys/class/net";
    try {
      for (const iface of fs.readdirSync(NET_DIR)) {
        if (!/^(en|eth)/.test(iface)) continue;
        if (!fs.existsSync(`${NET_DIR}/${iface}/device`)) continue;
        let carrier = "0";
        try {
          carrier = fs.readFileSync(`${NET_DIR}/${iface}/carrier`, "utf8").trim();
        } catch { /* link down; reading carrier fails when the iface is down */ }
        const addresses = os.networkInterfaces()[iface] || [];
        const v4 = addresses.find((a) => a.family === "IPv4" && !a.internal);
        return {
          present: true,
          iface,
          up: carrier === "1" && !!v4,
          ip: v4 ? v4.address : null,
        };
      }
    } catch { /* not Linux */ }
    return { present: false, iface: null, up: false, ip: null };
  }

  _boardModel() {
    try {
      const cpuinfo = fs.readFileSync("/proc/cpuinfo", "utf8");
      const m = cpuinfo.match(/^model name\s*:\s*(.+)$/m);
      if (m) return m[1].trim();
    } catch { /* not x86 */ }
    try {
      // Rockchip and other device-tree boards name themselves here instead.
      return fs.readFileSync("/proc/device-tree/model", "utf8").replace(/\0/g, "").trim();
    } catch { /* ignore */ }
    return "";
  }

  _appVersion() {
    try {
      return require("./package.json").version || "";
    } catch {
      return "";
    }
  }
}

module.exports = BleBridge;
module.exports.STATE = STATE;
module.exports.BleError = BleError;
