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
const fs = require('fs');
const EventEmitter = require('events');

const execAsync = promisify(exec);

const AP_CONNECTION_NAME  = 'DigitalPool-Hotspot';
const DEFAULT_AP_SSID     = 'DigitalPool-Camera'; // generic fallback — overridden at profile creation
const AP_SSID_PREFIX      = 'DigitalPool';         // prefix for MAC-based SSIDs
const DEFAULT_AP_PASSWORD = 'Digitalpool';   // min 8 chars for WPA2
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
    this.wifiIface   = null;  // AP / hotspot interface (onboard chip)
    this.clientIface = null;  // Client WiFi interface (USB dongle)
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
    // Ask NM first — returns the first wifi device found
    let r = await this._run("nmcli -t -f DEVICE,TYPE device | grep ':wifi' | head -1 | cut -d: -f1");
    if (r.ok && r.out) return r.out;
    // Fallback: first wl* interface from ip link
    r = await this._run("ip link show | grep -Eo 'wl[^:]+' | head -1");
    return r.ok ? r.out : null;
  }

  /**
   * Find the client WiFi interface — the adapter that is NOT running the AP.
   *
   * Strategy:
   *  1. `iw dev` lists every phy/interface with its current mode (AP / managed).
   *     Any interface in "managed" mode that isn't the AP iface is a client candidate.
   *  2. If iw is unavailable, fall back to nmcli's device list and pick any
   *     wifi device that differs from this.wifiIface.
   *
   * Returns null when only one WiFi adapter is present.
   */
  async _findClientIface() {
    // --- Strategy 1: iw dev (most reliable — shows actual hardware mode) ---
    const iw = await this._run("iw dev 2>/dev/null");
    if (iw.ok && iw.out) {
      let currentIface = null;
      const managed = [];
      for (const line of iw.out.split('\n')) {
        const ifaceMatch = line.match(/^\s+Interface\s+(\S+)/);
        if (ifaceMatch) { currentIface = ifaceMatch[1]; continue; }
        const typeMatch = line.match(/^\s+type\s+(\S+)/);
        if (typeMatch && currentIface) {
          if (typeMatch[1] === 'managed' && currentIface !== this.wifiIface) {
            managed.push(currentIface);
          }
          currentIface = null;
        }
      }
      if (managed.length > 0) {
        console.log(`📡 WiFi client adapter found via iw dev: ${managed[0]}`);
        this._noClientLogged = false;
        return managed[0];
      }
    }

    // --- Strategy 2: nmcli device list ---
    const nm = await this._run(
      "nmcli -t -f DEVICE,TYPE device status 2>/dev/null"
    );
    if (nm.ok && nm.out) {
      const ifaces = nm.out.split('\n')
        .filter(l => l.includes(':wifi'))
        .map(l => l.split(':')[0].trim())
        .filter(i => i && i !== this.wifiIface);
      if (ifaces.length > 0) {
        console.log(`📡 WiFi client adapter found via nmcli: ${ifaces[0]}`);
        this._noClientLogged = false;
        return ifaces[0];
      }
    }

    // getClientWifiStatus() re-runs detection every poll (every 30 s) while no
    // dongle is present, so only log the "not found" state once per transition.
    if (!this._noClientLogged) {
      console.log('📡 No second WiFi adapter found (only one interface present)');
      this._noClientLogged = true;
    }
    return null;
  }

  async _profileExists() {
    const r = await this._run(`nmcli connection show "${AP_CONNECTION_NAME}" 2>/dev/null`);
    return r.ok && r.out.length > 0;
  }

  /**
   * Return the interface name the existing AP profile is bound to, or null if
   * it is unbound (wildcard) or the profile doesn't exist.
   */
  async _profileBoundIface() {
    const r = await this._run(
      `nmcli -t -f connection.interface-name connection show "${AP_CONNECTION_NAME}" 2>/dev/null`
    );
    if (!r.ok || !r.out) return null;
    const match = r.out.match(/connection\.interface-name:(.*)/);
    if (!match) return null;
    const iface = match[1].trim();
    // NM reports '--' when the field is unset (unbound / wildcard)
    return (iface && iface !== '--') ? iface : null;
  }

  async _isAPActive() {
    const r = await this._run(`nmcli -t -f NAME,STATE connection show --active 2>/dev/null`);
    return r.ok && r.out.includes(AP_CONNECTION_NAME);
  }

  // ─── public API ────────────────────────────────────────────────────────────

  /**
   * Primary startup called by server.js.  Designed to work in two modes:
   *
   *   A) System-service mode (normal):
   *      digitalpool-hotspot.service already ran and the AP is up.
   *      This method just detects the interface, reads the SSID, and starts
   *      the health monitor — no profile creation or AP start needed.
   *
   *   B) Fallback mode (system service not installed / cloned device pre-install):
   *      The AP is not running yet.  This method performs a full initialisation:
   *      profile check/create (with new-hardware detection), dnsmasq config,
   *      AP start, and then the health monitor.  This means the hotspot works
   *      out-of-the-box on any cloned SD card even before the one-time install
   *      step has been run.
   */
  async startMonitor() {
    this.wifiIface = await this._findWifiIface();
    if (!this.wifiIface) {
      console.warn('⚠️  WiFi Manager: no wireless interface found — API will be limited');
      return false;
    }
    // Detect the USB dongle (second WiFi adapter) for client operations
    this.clientIface = await this._findClientIface();
    if (this.clientIface) {
      console.log(`📡 WiFi Manager: client adapter detected — ${this.clientIface}`);
    }

    // Read the SSID from the NM profile so getStatus() is accurate.
    const ssidR = await this._run(
      `nmcli -t -f 802-11-wireless.ssid connection show "${AP_CONNECTION_NAME}" 2>/dev/null`
    );
    if (ssidR.ok && ssidR.out) {
      const m = ssidR.out.match(/802-11-wireless\.ssid:(.*)/);
      if (m && m[1].trim()) this.apSsid = m[1].trim();
    }

    if (await this._isAPActive()) {
      // Mode A — system service already started the AP.
      console.log(`✅ WiFi Manager: hotspot already running (system service) — starting monitor on ${this.wifiIface}`);
    } else {
      // Mode B — AP is not up; run full initialisation as a fallback.
      console.log('📡 WiFi Manager: hotspot not running — running full initialisation (system service may not be installed)');
      await this._waitForDevice();

      if (!(await this._profileExists())) {
        console.log('📡 WiFi Manager: no AP profile found — creating one');
        if (!(await this._createProfile())) return false;
      } else {
        const boundIface = await this._profileBoundIface();
        if (boundIface && boundIface !== this.wifiIface) {
          console.log(`⚠️  AP profile bound to "${boundIface}", current interface "${this.wifiIface}" — recreating`);
          if (!(await this._createProfile())) return false;
        }
      }

      await this._ensureCaptivePortalDnsmasq();
      await this._startAP();
    }

    this._startMonitor();
    console.log(`✅ WiFi Manager: monitoring hotspot on ${this.wifiIface} (SSID: ${this.apSsid})`);
    return true;
  }

  /**
   * Ensure this.wifiIface is populated.  Called lazily by API methods so they
   * work even if startMonitor() hasn't been awaited yet (e.g. very early requests).
   */
  async _ensureIface() {
    if (!this.wifiIface) {
      this.wifiIface = await this._findWifiIface();
    }
  }

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
      console.log('📡 WiFi Manager: no AP profile found — creating one');
      if (!(await this._createProfile())) return false;
    } else {
      // Profile exists — but it may be bound to a different adapter (e.g. after
      // cloning the SD card to a device with a different WiFi dongle).  If the
      // bound interface doesn't match what we detected, delete and recreate so
      // the hotspot comes up on the correct hardware automatically.
      const boundIface = await this._profileBoundIface();
      if (boundIface && boundIface !== this.wifiIface) {
        console.log(`⚠️  AP profile is bound to "${boundIface}" but active interface is "${this.wifiIface}" — recreating for new hardware`);
        if (!(await this._createProfile())) return false;
      } else {
        console.log(`✅ WiFi Manager: AP profile exists and matches interface (${this.wifiIface})`);
      }
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

  /**
   * Return the device's primary hardware MAC (lowercase, colon-separated),
   * preferring the wired ethernet NIC (en/eth) over WiFi (wl) over any other
   * physical interface.  This is the SAME MAC the hostname suffix is derived from
   * (dp-stream-<XXXX>) — mirrors getPrimaryMac() in server.js and primary_mac()
   * in dp-firstboot.sh.  Reads /sys so a wired port with no cable still counts.
   * Returns "" if none can be read.
   */
  _primaryMac() {
    const NET_DIR = '/sys/class/net';
    const rank = (n) => (/^(en|eth)/.test(n) ? 0 : /^wl/.test(n) ? 1 : 2);
    try {
      const ordered = fs.readdirSync(NET_DIR).sort((a, b) => rank(a) - rank(b));
      for (const iface of ordered) {
        if (iface === 'lo') continue;
        if (!fs.existsSync(`${NET_DIR}/${iface}/device`)) continue; // skip virtual ifaces
        let mac = '';
        try { mac = fs.readFileSync(`${NET_DIR}/${iface}/address`, 'utf8').trim().toLowerCase(); }
        catch { continue; }
        if (mac && mac !== '00:00:00:00:00:00') return mac;
      }
    } catch { /* not Linux / no sysfs */ }
    return '';
  }

  /**
   * Build a device-unique SSID: "DigitalPool-<XXXX>" where XXXX is the last
   * 4 hex chars (2 bytes) of the *primary* (wired ethernet) MAC, upper-cased.
   * Using the wired MAC — not the WiFi adapter's — makes the SSID match the
   * NetBird device name (hostname dp-stream-<XXXX>) and keeps it stable no matter
   * which WiFi dongle is fitted.  Falls back to DEFAULT_AP_SSID if unreadable.
   */
  async _defaultSsid() {
    try {
      const mac    = this._primaryMac().replace(/:/g, '').toUpperCase();
      const suffix = mac.slice(-4);
      if (suffix.length === 4) return `${AP_SSID_PREFIX}-${suffix}`;
    } catch { /* fall through */ }
    return DEFAULT_AP_SSID;
  }

  async _createProfile() {
    // Personalise the SSID for this device if it's still the generic boot-time
    // default.  Uses the last 4 hex chars of the WiFi adapter MAC so two units
    // in the same room show up as e.g. "DigitalPool-A1B2" / "DigitalPool-C3D4".
    if (this.apSsid === DEFAULT_AP_SSID) {
      this.apSsid = await this._defaultSsid();
    }
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

  // ── Captive portal: iptables port redirect ───────────────────────────────
  // Devices probe port 80 (HTTP) and port 443 (HTTPS — iOS 14+); our app
  // listens on 3000 (HTTP) and 3443 (HTTPS).  PREROUTING REDIRECT rules
  // forward both transparently so Express handles them.
  // Requires a sudoers entry — see README § 7c.
  async _setupCaptivePortalIptables() {
    const appPort   = process.env.PORT || 3000;
    const httpsPort = 3443;
    const iface     = this.wifiIface;

    // Port 80 → Express HTTP
    const rule80 = `-t nat -A PREROUTING -i "${iface}" -p tcp --dport 80 -j REDIRECT --to-port ${appPort}`;
    await this._run(`sudo iptables ${rule80.replace('-A', '-D')} 2>/dev/null`);
    const r80 = await this._run(`sudo iptables ${rule80}`);
    if (r80.ok) console.log(`✅ Captive portal: port 80 → ${appPort} redirect active on ${iface}`);
    else        console.warn('⚠️  Captive portal iptables port 80 rule failed (add sudoers entry — see README § 7c):', r80.err.split('\n')[0]);

    // Port 443 → Express HTTPS (iOS 14+ uses HTTPS for captive portal probes)
    const rule443 = `-t nat -A PREROUTING -i "${iface}" -p tcp --dport 443 -j REDIRECT --to-port ${httpsPort}`;
    await this._run(`sudo iptables ${rule443.replace('-A', '-D')} 2>/dev/null`);
    const r443 = await this._run(`sudo iptables ${rule443}`);
    if (r443.ok) console.log(`✅ Captive portal: port 443 → ${httpsPort} redirect active on ${iface}`);
    else         console.warn('⚠️  Captive portal iptables port 443 rule failed:', r443.err.split('\n')[0]);
  }

  async _teardownCaptivePortalIptables() {
    const appPort   = process.env.PORT || 3000;
    const httpsPort = 3443;
    const iface     = this.wifiIface;
    await Promise.all([
      this._run(`sudo iptables -t nat -D PREROUTING -i "${iface}" -p tcp --dport 80  -j REDIRECT --to-port ${appPort}   2>/dev/null`),
      this._run(`sudo iptables -t nat -D PREROUTING -i "${iface}" -p tcp --dport 443 -j REDIRECT --to-port ${httpsPort} 2>/dev/null`),
    ]);
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
    await this._ensureIface();

    // Prefer the dedicated client adapter for scanning — it supports active
    // rescans without disrupting the AP.  Fall back to the AP interface
    // (cached results only, since active rescan on an AP interface fails).
    const scanIface = this.clientIface || this.wifiIface;
    const canRescan = !!this.clientIface; // active rescan safe on managed iface

    if (canRescan) {
      console.log(`📡 Scanning for networks on client adapter ${scanIface}...`);
      await this._run(`nmcli device wifi rescan ifname ${scanIface} 2>/dev/null`);
      await new Promise(r => setTimeout(r, 2500));
    } else {
      console.log('📡 Scanning for networks (cached, AP is active on only adapter)...');
    }

    const rescanFlag = canRescan ? '' : '--rescan no';
    const ifaceFlag  = `ifname ${scanIface}`;
    let r = await this._run(
      `nmcli -t --escape no -f SSID,SIGNAL,SECURITY,ACTIVE device wifi list ${ifaceFlag} ${rescanFlag} 2>/dev/null`
    );

    // Fallback: iw scan
    if (!r.ok || !r.out.trim()) {
      console.log('📡 NM cache empty, trying iw scan fallback...');
      const iw = await this._run(`iw dev ${scanIface} scan 2>/dev/null`);
      if (iw.ok && iw.out) {
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

    // Parse nmcli -t output.  Fields: SSID:SIGNAL:SECURITY:ACTIVE
    // SSID may contain colons so split from the right.
    const seen = new Set();
    return r.out.split('\n')
      .map(line => {
        const parts = line.split(':');
        if (parts.length < 4) return null;
        const active   = parts.pop();
        const security = parts.pop();
        const signal   = parts.pop();
        const ssid     = parts.join(':').trim(); // rejoin in case SSID contained ':'
        if (!ssid || ssid === '--' || ssid === this.apSsid) return null;
        if (seen.has(ssid)) return null;
        seen.add(ssid);
        return { ssid, signal: parseInt(signal) || 0, security, connected: active === 'yes' };
      })
      .filter(Boolean)
      .sort((a, b) => b.signal - a.signal);
  }

  /**
   * Connect to a WiFi network as a client using the dedicated client adapter.
   * The AP continues running on the hotspot interface.
   */
  async connectToNetwork(ssid, password) {
    await this._ensureIface();
    // Always use the client (USB dongle) interface when available
    const iface = this.clientIface || this.wifiIface;
    console.log(`📡 Connecting to: ${ssid} on ${iface}`);

    // Use connection add + up with explicit security properties.
    // nmcli device wifi connect doesn't support property overrides and triggers
    // "property is missing" on drivers (e.g. AIC8800) that don't expose security
    // capabilities during scan. Creating the profile explicitly avoids this.
    await this._run(`nmcli connection delete "${ssid}" 2>/dev/null`);
    const secArgs = password
      ? `-- 802-11-wireless-security.key-mgmt wpa-psk 802-11-wireless-security.psk "${password}"`
      : '';
    const addR = await this._run(
      `nmcli connection add type wifi ssid "${ssid}" ifname "${iface}" con-name "${ssid}" autoconnect yes ${secArgs}`
    );
    let r = addR.ok
      ? await this._run(`nmcli connection up "${ssid}" ifname "${iface}"`)
      : addR;

    if (r.ok) {
      console.log(`✅ Connected to ${ssid} on ${iface}`);
      // Re-assert AP after client association (some drivers briefly drop it)
      if (!this.clientIface) setTimeout(() => this._startAP(), 5000);
      return { success: true, message: `Connected to ${ssid}` };
    }
    console.error(`❌ Connect failed on ${iface}:`, r.err);
    return { success: false, error: r.err };
  }

  /**
   * Disconnect from the current client WiFi network.
   */
  async disconnectFromNetwork() {
    // Prefer disconnecting the client interface directly
    if (this.clientIface) {
      const r = await this._run(`nmcli device disconnect "${this.clientIface}" 2>/dev/null`);
      return r.ok ? { success: true } : { success: false, error: r.err };
    }
    const current = await this._currentClientConnection();
    if (!current) return { success: false, error: 'Not connected to any network' };
    const r = await this._run(`nmcli connection down "${current}"`);
    return r.ok ? { success: true } : { success: false, error: r.err };
  }

  /**
   * Return the current state of the WiFi client adapter (USB dongle).
   * Returns { available, iface, state, ssid, ip }.
   */
  async getClientWifiStatus() {
    // Re-detect on every call if not found at startup — handles dongles plugged
    // in after boot or interfaces that weren't ready when startMonitor() ran.
    if (!this.clientIface) {
      this.clientIface = await this._findClientIface();
    }
    const iface = this.clientIface;
    if (!iface) return { available: false, reason: 'No USB WiFi adapter detected' };

    const stateR = await this._run(
      `nmcli -t -f GENERAL.STATE,GENERAL.CONNECTION device show "${iface}" 2>/dev/null`
    );
    let state = 'disconnected', ssid = null;
    if (stateR.ok) {
      const stateMatch = stateR.out.match(/GENERAL\.STATE:(\d+)/);
      const connMatch  = stateR.out.match(/GENERAL\.CONNECTION:(.*)/);
      if (stateMatch && parseInt(stateMatch[1]) >= 100) state = 'connected';
      if (connMatch && connMatch[1].trim() !== '--') ssid = connMatch[1].trim();
    }

    let ip = null;
    if (state === 'connected') {
      const ipR = await this._run(
        `nmcli -t -f IP4.ADDRESS device show "${iface}" 2>/dev/null`
      );
      if (ipR.ok) {
        const m = ipR.out.match(/IP4\.ADDRESS\[1\]:(.*)/);
        if (m) ip = m[1].trim().split('/')[0];
      }
    }

    return { available: true, iface, state, ssid, ip };
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
    const [apActive, current, clientStatus] = await Promise.all([
      this._isAPActive(),
      this._currentClientConnection(),
      this.getClientWifiStatus(),
    ]);
    this.apRunning = apActive;
    const port = process.env.PORT || 3000;
    return {
      apRunning:        apActive,
      apSsid:           this.apSsid,
      apPassword:       this.apPassword,
      apIp:             this.apIp,
      apAdminUrl:       `http://${this.apIp}:${port}`,
      wifiInterface:    this.wifiIface,
      connectedNetwork: current || null,
      client:           clientStatus,
    };
  }
}

module.exports = WifiManager;
