'use strict';

/**
 * wifiManager.js
 *
 * Manages a persistent WiFi hotspot (Access Point) using NetworkManager (nmcli).
 * The AP runs continuously alongside any regular WiFi client connection,
 * so the admin UI is always reachable at http://<AP_IP>:<PORT> via the hotspot.
 *
 * Requires: NetworkManager (nmcli), Linux kernel with AP+STA support on the adapter.
 */

const { exec } = require('child_process');
const { promisify } = require('util');
const EventEmitter = require('events');

const execAsync = promisify(exec);

const AP_CONNECTION_NAME = 'DigitalPool-Hotspot';
const DEFAULT_AP_SSID     = 'DigitalPool-Camera';
const DEFAULT_AP_PASSWORD = 'digitalpool';   // min 8 chars for WPA2
const DEFAULT_AP_IP       = '192.168.50.1';
const AP_SUBNET_PREFIX    = '24';
const AP_CHANNEL          = '6';
const MONITOR_INTERVAL_MS = 30_000; // re-check AP health every 30 s

class WifiManager extends EventEmitter {
  constructor(options = {}) {
    super();
    this.apSsid      = options.apSsid     || DEFAULT_AP_SSID;
    this.apPassword  = options.apPassword || DEFAULT_AP_PASSWORD;
    this.apIp        = options.apIp       || DEFAULT_AP_IP;
    this.apRunning   = false;
    this.wifiIface   = null;
    this._monitor    = null;
  }

  // ─── internal helpers ──────────────────────────────────────────────────────

  async _run(cmd) {
    try {
      const { stdout, stderr } = await execAsync(cmd, { timeout: 15_000 });
      return { ok: true, out: stdout.trim(), err: stderr.trim() };
    } catch (e) {
      return { ok: false, out: '', err: e.message };
    }
  }

  async _findWifiIface() {
    // Ask NM first
    let r = await this._run("nmcli -t -f DEVICE,TYPE device | grep ':wifi' | head -1 | cut -d: -f1");
    if (r.ok && r.out) return r.out;
    // Fallback: first wl* interface from ip link
    r = await this._run("ip link show | grep -Eo 'wl[^:]+' | head -1");
    return r.ok ? r.out : null;
  }

  async _profileExists() {
    const r = await this._run(`nmcli connection show "${AP_CONNECTION_NAME}" 2>/dev/null`);
    return r.ok && r.out.length > 0;
  }

  async _isAPActive() {
    const r = await this._run(`nmcli -t -f NAME,STATE connection show --active 2>/dev/null`);
    return r.ok && r.out.includes(AP_CONNECTION_NAME);
  }

  // ─── public API ────────────────────────────────────────────────────────────

  /**
   * Initialize: detect interface, create NM profile if needed, start AP, begin monitoring.
   */
  async initialize() {
    console.log('📡 WiFi Manager: initializing...');
    this.wifiIface = await this._findWifiIface();
    if (!this.wifiIface) {
      console.warn('⚠️  WiFi Manager: no wireless interface found — AP unavailable');
      return false;
    }
    console.log(`📡 WiFi Manager: using interface ${this.wifiIface}`);

    if (!(await this._profileExists())) {
      if (!(await this._createProfile())) return false;
    } else {
      console.log('✅ WiFi Manager: AP profile already exists');
    }

    await this._startAP();
    this._startMonitor();
    return true;
  }

  async _createProfile() {
    console.log(`📡 Creating AP profile "${AP_CONNECTION_NAME}" (SSID: ${this.apSsid})`);
    // Remove stale profile if any
    await this._run(`nmcli connection delete "${AP_CONNECTION_NAME}" 2>/dev/null`);

    const cmd = [
      'nmcli connection add',
      `type wifi`,
      `ifname "${this.wifiIface}"`,
      `con-name "${AP_CONNECTION_NAME}"`,
      `autoconnect no`,
      `ssid "${this.apSsid}"`,
      `--`,
      `wifi.mode ap`,
      `wifi.band bg`,
      `wifi.channel ${AP_CHANNEL}`,
      `wifi-sec.key-mgmt wpa-psk`,
      `wifi-sec.psk "${this.apPassword}"`,
      `ipv4.method shared`,
      `ipv4.addresses "${this.apIp}/${AP_SUBNET_PREFIX}"`,
      `ipv6.method ignore`,
    ].join(' ');

    const r = await this._run(cmd);
    if (!r.ok) { console.error('❌ AP profile create failed:', r.err); return false; }
    console.log('✅ AP profile created');
    return true;
  }

  async _startAP() {
    if (await this._isAPActive()) {
      console.log('✅ WiFi Manager: AP already active');
      this.apRunning = true;
      return true;
    }
    console.log(`📡 Starting AP: ${this.apSsid}`);
    const r = await this._run(`nmcli connection up "${AP_CONNECTION_NAME}"`);
    if (r.ok) {
      this.apRunning = true;
      console.log(`✅ AP up — SSID: ${this.apSsid}  IP: ${this.apIp}`);
      this.emit('apStarted', { ssid: this.apSsid, ip: this.apIp });
      return true;
    }
    this.apRunning = false;
    console.error('❌ AP start failed:', r.err);
    this.emit('apError', { error: r.err });
    return false;
  }

  _startMonitor() {
    if (this._monitor) clearInterval(this._monitor);
    this._monitor = setInterval(async () => {
      const active = await this._isAPActive();
      if (!active) {
        console.warn('⚠️  AP went down — attempting restart...');
        await this._startAP();
      }
      this.apRunning = active;
    }, MONITOR_INTERVAL_MS);
    this._monitor.unref(); // don't block process exit
  }

  /**
   * Scan for nearby WiFi networks (excludes the AP itself).
   * Returns array of { ssid, signal, security, connected }.
   */
  async scanNetworks() {
    await this._run(`nmcli device wifi rescan ifname ${this.wifiIface} 2>/dev/null`);
    await new Promise(r => setTimeout(r, 2500));
    const r = await this._run(
      `nmcli -t -f SSID,SIGNAL,SECURITY,ACTIVE device wifi list ifname ${this.wifiIface} 2>/dev/null`
    );
    if (!r.ok) return [];
    const seen = new Set();
    return r.out.split('\n')
      .map(line => {
        const parts = line.split(':');
        if (parts.length < 4) return null;
        const [ssid, signal, security, active] = parts;
        if (!ssid || ssid === '--' || ssid === this.apSsid) return null;
        if (seen.has(ssid)) return null;
        seen.add(ssid);
        return { ssid, signal: parseInt(signal) || 0, security, connected: active === 'yes' };
      })
      .filter(Boolean)
      .sort((a, b) => b.signal - a.signal);
  }

  /**
   * Connect to a WiFi network as a client. The AP continues running.
   */
  async connectToNetwork(ssid, password) {
    console.log(`📡 Connecting to: ${ssid}`);
    const pw = password ? `password "${password}"` : '';
    const r = await this._run(
      `nmcli device wifi connect "${ssid}" ${pw} ifname ${this.wifiIface}`
    );
    if (r.ok) {
      console.log(`✅ Connected to ${ssid}`);
      // Re-assert AP after client association (some drivers briefly drop it)
      setTimeout(() => this._startAP(), 5000);
      return { success: true, message: `Connected to ${ssid}` };
    }
    console.error(`❌ Connect failed:`, r.err);
    return { success: false, error: r.err };
  }

  /**
   * Disconnect from the current client WiFi network.
   */
  async disconnectFromNetwork() {
    const current = await this._currentClientConnection();
    if (!current) return { success: false, error: 'Not connected to any network' };
    const r = await this._run(`nmcli connection down "${current}"`);
    return r.ok ? { success: true } : { success: false, error: r.err };
  }

  async _currentClientConnection() {
    const r = await this._run(
      `nmcli -t -f NAME,TYPE,STATE connection show --active 2>/dev/null`
    );
    if (!r.ok) return null;
    for (const line of r.out.split('\n')) {
      const [name, type] = line.split(':');
      if (type === 'wifi' && name !== AP_CONNECTION_NAME) return name;
    }
    return null;
  }

  /**
   * Update the AP SSID and/or password and restart it.
   */
  async updateAPConfig({ ssid, password } = {}) {
    if (ssid)     this.apSsid     = ssid;
    if (password) this.apPassword = password;
    await this._run(`nmcli connection down "${AP_CONNECTION_NAME}" 2>/dev/null`);
    const ok = await this._createProfile();
    return ok ? this._startAP() : false;
  }

  /**
   * Return the full current status (AP + client WiFi + IP info).
   */
  async getStatus() {
    const [apActive, current] = await Promise.all([
      this._isAPActive(),
      this._currentClientConnection(),
    ]);
    this.apRunning = apActive;
    const port = process.env.PORT || 3000;
    return {
      apRunning:      apActive,
      apSsid:         this.apSsid,
      apPassword:     this.apPassword,
      apIp:           this.apIp,
      apAdminUrl:     `http://${this.apIp}:${port}`,
      wifiInterface:  this.wifiIface,
      connectedNetwork: current || null,
    };
  }
}

module.exports = WifiManager;
