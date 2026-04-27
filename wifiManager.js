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
   * Wait until NetworkManager reports the interface as ready (state >= 30 / disconnected).
   * USB adapters can take several seconds after boot to initialise.
   *
   * NM device states:
   *   10 = unmanaged  → actively set managed=yes, then keep polling
   *   20 = unavailable (managed, hardware not ready yet) → keep polling
   *   30 = disconnected → ready ✅
   *   40+ = connecting / connected → ready ✅
   */
  async _waitForDevice(maxWaitMs = 60_000, intervalMs = 3_000) {
    const deadline = Date.now() + maxWaitMs;
    let setManagedAttempted = false;
    console.log(`⏳ Waiting for ${this.wifiIface} to become available...`);

    while (Date.now() < deadline) {
      const r = await this._run(
        `nmcli -t -f GENERAL.STATE device show "${this.wifiIface}" 2>/dev/null`
      );

      if (r.ok && r.out) {
        const match = r.out.match(/(\d+)/);
        const state = match ? parseInt(match[1]) : 0;
        console.log(`   ${this.wifiIface} NM state: ${r.out.trim()}`);

        if (state >= 30) {
          console.log(`✅ ${this.wifiIface} is ready (state ${state})`);
          return true;
        }

        // State 10 = unmanaged — tell NM to take control of this device
        if (state === 10 && !setManagedAttempted) {
          setManagedAttempted = true;
          console.log(`📡 Device is unmanaged — setting managed=yes on ${this.wifiIface}...`);
          const m = await this._run(`nmcli device set "${this.wifiIface}" managed yes`);
          if (m.ok) {
            console.log('✅ Device set to managed, waiting for NM to take over...');
          } else {
            console.error('❌ Could not set device managed:', m.err);
          }
        }
      }

      await new Promise(res => setTimeout(res, intervalMs));
    }

    console.warn(`⚠️  Timed out waiting for ${this.wifiIface} to become ready`);
    return false;
  }

  /**
   * Initialize: detect interface, wait for device, create NM profile if needed,
   * start AP, begin monitoring.
   */
  async initialize() {
    console.log('📡 WiFi Manager: initializing...');
    this.wifiIface = await this._findWifiIface();
    if (!this.wifiIface) {
      console.warn('⚠️  WiFi Manager: no wireless interface found — AP unavailable');
      return false;
    }
    console.log(`📡 WiFi Manager: using interface ${this.wifiIface}`);

    // Wait for the USB WiFi adapter to be fully ready before touching NM
    await this._waitForDevice();

    if (!(await this._profileExists())) {
      if (!(await this._createProfile())) return false;
    } else {
      console.log('✅ WiFi Manager: AP profile already exists');
    }

    await this._ensureCaptivePortalDnsmasq();
    await this._startAP();
    this._startMonitor();
    return true;
  }

  /**
   * Write a dnsmasq config that resolves every hostname to the AP IP.
   * NM picks up files from /etc/NetworkManager/dnsmasq-shared.d/ when it
   * starts its internal dnsmasq for an ipv4.method=shared connection.
   * Requires: sudo tee access granted via sudoers (see README § 7c).
   */
  async _ensureCaptivePortalDnsmasq() {
    const confDir  = '/etc/NetworkManager/dnsmasq-shared.d';
    const confFile = `${confDir}/captive-portal.conf`;
    const content  = `# Redirect all DNS queries to the AP for captive portal\naddress=/#/${this.apIp}\n`;

    // Check whether file already contains the right address
    const check = await this._run(`cat "${confFile}" 2>/dev/null`);
    if (check.ok && check.out.includes(`address=/#/${this.apIp}`)) {
      console.log('✅ Captive portal dnsmasq config already in place');
      return;
    }

    const r = await this._run(
      `sudo mkdir -p "${confDir}" && printf '%s' '${content}' | sudo tee "${confFile}" > /dev/null`
    );
    if (r.ok) {
      console.log('✅ Captive portal dnsmasq config written — reloading NetworkManager');
      await this._run('sudo systemctl reload NetworkManager 2>/dev/null || true');
    } else {
      console.warn('⚠️  Could not write captive portal dnsmasq config (add sudoers entry — see README § 7c):', r.err.split('\n')[0]);
    }
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

  // ── Captive portal: iptables port-80 → port-3000 redirect ────────────────
  // Devices probe port 80; our app listens on 3000.  A PREROUTING REDIRECT
  // rule forwards the traffic transparently so Express handles it.
  // Requires a sudoers entry — see README § 7c.
  async _setupCaptivePortalIptables() {
    const appPort = process.env.PORT || 3000;
    const rule    = `-t nat -A PREROUTING -i "${this.wifiIface}" -p tcp --dport 80 -j REDIRECT --to-port ${appPort}`;
    // Avoid duplicates: try to delete first (ignore failure), then add
    await this._run(`sudo iptables ${rule.replace('-A', '-D')} 2>/dev/null`);
    const r = await this._run(`sudo iptables ${rule}`);
    if (r.ok) {
      console.log(`✅ Captive portal: port 80 → ${appPort} redirect active on ${this.wifiIface}`);
    } else {
      console.warn('⚠️  Captive portal iptables rule failed (add sudoers entry — see README § 7c):', r.err.split('\n')[0]);
    }
  }

  async _teardownCaptivePortalIptables() {
    const appPort = process.env.PORT || 3000;
    const rule    = `-t nat -D PREROUTING -i "${this.wifiIface}" -p tcp --dport 80 -j REDIRECT --to-port ${appPort}`;
    await this._run(`sudo iptables ${rule} 2>/dev/null`);
  }
  // ─────────────────────────────────────────────────────────────────────────

  async _startAP(retries = 5, retryDelayMs = 5_000) {
    if (await this._isAPActive()) {
      console.log('✅ WiFi Manager: AP already active');
      this.apRunning = true;
      await this._setupCaptivePortalIptables();
      return true;
    }
    for (let attempt = 1; attempt <= retries; attempt++) {
      console.log(`📡 Starting AP: ${this.apSsid} (attempt ${attempt}/${retries})`);
      const r = await this._run(`nmcli connection up "${AP_CONNECTION_NAME}"`);
      if (r.ok) {
        this.apRunning = true;
        console.log(`✅ AP up — SSID: ${this.apSsid}  IP: ${this.apIp}`);
        await this._setupCaptivePortalIptables();
        this.emit('apStarted', { ssid: this.apSsid, ip: this.apIp });
        return true;
      }
      console.warn(`⚠️  AP start attempt ${attempt} failed: ${r.err.split('\n')[0]}`);
      if (attempt < retries) {
        console.log(`   Retrying in ${retryDelayMs / 1000}s...`);
        await new Promise(res => setTimeout(res, retryDelayMs));
      }
    }
    this.apRunning = false;
    console.error(`❌ AP failed to start after ${retries} attempts`);
    this.emit('apError', { error: 'AP failed to start after retries' });
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
   *
   * When the interface is in AP mode we cannot trigger an active rescan on it —
   * instead we ask NM for its cached results (--rescan no) which it builds up
   * in the background.  If the cache is empty we fall back to iw scan.
   */
  async scanNetworks() {
    const apActive = await this._isAPActive();

    if (!apActive) {
      // Managed/idle mode — we can request a fresh scan
      console.log('📡 Scanning for networks (active rescan)...');
      await this._run(`nmcli device wifi rescan ifname ${this.wifiIface} 2>/dev/null`);
      await new Promise(r => setTimeout(r, 2500));
    } else {
      // AP mode — active rescan on this interface would fail/hang.
      // Use NM's background-cached results; no wait needed.
      console.log('📡 Scanning for networks (cached, AP is active)...');
    }

    // Try NM cached list first (no ifname so NM searches all managed ifaces)
    const rescanFlag = apActive ? '--rescan no' : '';
    let r = await this._run(
      `nmcli -t -f SSID,SIGNAL,SECURITY,ACTIVE device wifi list ${rescanFlag} 2>/dev/null`
    );

    // Fallback: iw scan (works on many drivers even in AP mode via passive scan)
    if (!r.ok || !r.out.trim()) {
      console.log('📡 NM cache empty, trying iw scan fallback...');
      const iw = await this._run(`iw dev ${this.wifiIface} scan 2>/dev/null`);
      if (iw.ok && iw.out) {
        // Parse iw scan output into the same shape
        const results = [];
        const seen = new Set();
        for (const line of iw.out.split('\n')) {
          const ssidMatch = line.match(/SSID:\s+(.+)/);
          if (ssidMatch) {
            const ssid = ssidMatch[1].trim();
            if (ssid && !seen.has(ssid) && ssid !== this.apSsid) {
              seen.add(ssid);
              results.push({ ssid, signal: 50, security: 'WPA', connected: false });
            }
          }
        }
        return results;
      }
      return [];
    }

    // Parse nmcli -t output
    if (!r2.ok) return [];
    const seen = new Set();
    return r2.out.split('\n')
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
