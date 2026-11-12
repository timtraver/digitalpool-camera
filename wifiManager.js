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

const { exec, execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const EventEmitter = require('events');

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

const AP_CONNECTION_NAME  = 'DigitalPool-Hotspot';
const DEFAULT_AP_SSID     = 'DigitalPool-Camera'; // generic fallback — overridden at profile creation
const AP_SSID_PREFIX      = 'DigitalPool';         // prefix for MAC-based SSIDs
const DEFAULT_AP_PASSWORD = 'Digitalpool';   // min 8 chars for WPA2
const DEFAULT_AP_IP       = '192.168.50.1';
const AP_SUBNET_PREFIX    = '24';
const AP_CHANNEL          = '6';
const MONITOR_INTERVAL_MS = 30_000; // re-check AP health every 30 s

// Temporary profile name while a new network is being proved.  Deliberately
// not the SSID: the old working profile must survive until the new one is
// known good (§8.2).
const SETUP_PROFILE = 'dp-setup-candidate';

// nmcli waits this long for `connection up` before giving up.  DHCP on a busy
// venue AP is the slow part; 45 s is the §8.2 budget.
const CONNECT_WAIT_S = 45;

/**
 * Validate an SSID.  1–32 **bytes** — the 802.11 limit is bytes, not
 * characters, so a name in Kanji runs out sooner than a name in English.
 */
function validateSsid(ssid) {
  if (typeof ssid !== 'string' || ssid.length === 0) return 'An SSID is required';
  const bytes = Buffer.byteLength(ssid, 'utf8');
  if (bytes > 32) return 'That network name is too long (max 32 bytes)';
  return null;
}

/**
 * Validate a pre-shared key.  WPA-PSK is either an 8–63 character printable
 * ASCII passphrase or exactly 64 hex characters (the raw key).  Anything else
 * NetworkManager would reject later and less clearly.
 */
function validatePsk(psk) {
  if (typeof psk !== 'string') return 'The password must be text';
  if (/^[0-9a-fA-F]{64}$/.test(psk)) return null;
  if (psk.length < 8)  return 'A WiFi password must be at least 8 characters';
  if (psk.length > 63) return 'A WiFi password can be at most 63 characters';
  if (!/^[\x20-\x7e]+$/.test(psk)) return 'That password contains characters WiFi cannot carry';
  return null;
}

/**
 * Turn what a scan reported into an nmcli key-mgmt value.
 *
 * WPA2/WPA3 transition networks advertise both; `wpa-psk` is the right answer
 * there because NetworkManager negotiates up to SAE by itself, whereas pinning
 * `sae` fails against an AP that only offers WPA2.
 */
function keyMgmtFor(security, hasPassword) {
  const sec = (security || '').toUpperCase();
  if (!sec || sec === '--') return hasPassword ? 'wpa-psk' : 'none';
  if (sec.includes('WPA2') || sec.includes('WPA1') || sec.includes('RSN')) return 'wpa-psk';
  if (sec.includes('WPA3') || sec.includes('SAE')) return 'sae';
  if (sec.includes('WPA')) return 'wpa-psk';
  if (sec.includes('WEP')) return 'wep';
  if (sec.includes('802.1X') || sec.includes('EAP')) return 'enterprise';
  return hasPassword ? 'wpa-psk' : 'none';
}

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

    // `auto` | `ble` | `hotspot` (§8.1).  Under `ble` the onboard radio is the
    // internet connection and the hotspot is on-demand, so the health monitor
    // must not keep resurrecting an AP that was taken down on purpose.
    this.onboardingMode = options.onboardingMode
      || process.env.ONBOARDING_MODE
      || 'auto';
    // Whether the AP is *supposed* to be up.  The monitor restarts the AP only
    // when this is true; connectToNetwork() clears it before borrowing the
    // radio.  In `ble` mode the hotspot starts out not wanted at all.
    this.apDesired = this.onboardingMode !== 'ble';
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

  /**
   * Run a command with an argument array and **no shell**.
   *
   * Every call that carries user input must use this rather than _run().
   * connectToNetwork() used to paste the SSID and password into a shell string
   * inside double quotes, so a password containing a quote and a semicolon ran
   * commands as `dp`.  That was reachable only by a logged-in admin until BLE
   * onboarding arrived; now it is reachable by anyone within radio range,
   * through a parser we did not write.  See BLUETOOTH_ONBOARDING.md §8.2.
   */
  async _runArgs(bin, args, { timeout = 15_000 } = {}) {
    try {
      const { stdout, stderr } = await execFileAsync(bin, args, { timeout });
      return { ok: true, out: (stdout || '').trim(), err: (stderr || '').trim() };
    } catch (e) {
      // nmcli puts the useful part on stderr and still sets a non-zero exit.
      return {
        ok: false,
        out: (e.stdout || '').trim(),
        err: ((e.stderr || '') + ' ' + (e.message || '')).trim(),
      };
    }
  }

  async _findWifiIface() {
    // Ask NM first.  Match the TYPE field exactly: `grep ':wifi'` also matches
    // `:wifi-p2p`, and every iwlwifi card (every N100, so every production
    // box) exposes a `p2p-dev-*` device that can neither scan nor associate.
    const r = await this._runArgs('nmcli', ['-t', '-f', 'DEVICE,TYPE', 'device']);
    if (r.ok && r.out) {
      for (const line of r.out.split('\n')) {
        const [device, type] = line.split(':');
        if (type === 'wifi' && device && !device.startsWith('p2p-dev-')) return device;
      }
    }
    // Fallback: first wl* interface from ip link
    const fallback = await this._run("ip link show | grep -Eo 'wl[^:]+' | head -1");
    return fallback.ok && fallback.out ? fallback.out : null;
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
          if (typeMatch[1] === 'managed' && currentIface !== this.wifiIface
              && !currentIface.startsWith('p2p-dev-')) {
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
      // Match the TYPE field exactly.  `includes(':wifi')` also matched
      // `:wifi-p2p`, so on any adapter that exposes a P2P device — every
      // iwlwifi card does, which is the N100 and every production box — this
      // returned `p2p-dev-wlp1s0` and the app believed it had a second WiFi
      // adapter.  That is a virtual control interface: it can neither scan nor
      // associate, so net.status reported a phantom client and a connect would
      // have been aimed at nothing.
      const ifaces = nm.out.split('\n')
        .map(l => l.split(':'))
        .filter(parts => parts.length >= 2 && parts[1].trim() === 'wifi')
        .map(parts => parts[0].trim())
        .filter(i => i && i !== this.wifiIface && !i.startsWith('p2p-dev-'));
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

    if (this.onboardingMode === 'ble') {
      // Mode C — BLE onboarding.  The onboard radio is the internet
      // connection and the hotspot is started on demand (§2 D6).
      this.apDesired = false;
      // Always, not just when the AP happens to be up right now. dp-hotspot.sh
      // stands down in this mode, but NetworkManager's own autoconnect is a
      // separate mechanism: the hotspot profile sitting at autoconnect=yes,
      // priority 100 would have it grab the radio back on the next reboot and
      // take the box off the network it was told to join. Observed on
      // dp-stream-b1b5 after it had successfully joined a venue network.
      await this._runArgs('nmcli', ['connection', 'modify', AP_CONNECTION_NAME,
                                    'connection.autoconnect', 'no']);
      await this._runArgs('nmcli', ['connection', 'modify', AP_CONNECTION_NAME,
                                    'connection.autoconnect-priority', '0']);
      if (await this._isAPActive()) {
        // Left over from before this box was switched to BLE, or from a boot
        // that happened before dp-hotspot.sh learned about the mode.  It has
        // to come down: while the AP owns the radio the box cannot scan for
        // networks, so the app's network picker would be empty and the user
        // would have nothing to choose.
        console.log('📡 WiFi Manager: ONBOARDING_MODE=ble — taking the leftover hotspot down');
        await this._runArgs('nmcli', ['connection', 'down', AP_CONNECTION_NAME]);
      } else {
        console.log('📡 WiFi Manager: ONBOARDING_MODE=ble — no hotspot on this camera');
      }
      this.apRunning = false;
    } else if (await this._isAPActive()) {
      // Mode A — system service already started the AP.
      console.log(`✅ WiFi Manager: hotspot already running (system service) — starting monitor on ${this.wifiIface}`);
      this.apDesired = true;
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
    console.log(this.onboardingMode === 'ble'
      ? `✅ WiFi Manager: ${this.wifiIface} is the client radio, no hotspot`
      : `✅ WiFi Manager: monitoring hotspot on ${this.wifiIface} (SSID: ${this.apSsid})`);
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
    // The one chokepoint for "the hotspot comes up". Under `ble` onboarding the
    // camera never runs one (§2 D6, reversed 2026-11-10): the onboard radio is
    // the venue internet connection and Bluetooth is how a phone reaches the
    // box, including when there is no network at all. Guarding here rather
    // than at each caller is deliberate — the health monitor, a failed
    // connect's rollback, updateAPConfig() from the admin API and the Mode B
    // fallback in startMonitor() all land on this method, and any one of them
    // getting it wrong would put a WPA2 AP on the air at a venue that is not
    // expecting one.
    if (this.onboardingMode === 'ble') {
      console.log('📡 WiFi Manager: ONBOARDING_MODE=ble — refusing to start the hotspot');
      this.apRunning = false;
      return false;
    }
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
      // Only resurrect an AP that is supposed to be up.  Without this check
      // the monitor fights connectToNetwork() for the radio on any box with
      // one, and an on-demand hotspot could never be turned off.
      if (!active && this.apDesired) {
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
    // An active rescan is safe on any interface that is NOT currently running
    // the AP.  Keying this off "is there a dongle" was right when the onboard
    // chip was always the hotspot; under BLE onboarding it is the client, and
    // assuming otherwise left the app's network picker showing whatever stale
    // cache NetworkManager happened to have — empty, on a box fresh out of its
    // box, which is exactly when somebody needs to pick a network.
    const apOnScanIface = scanIface === this.wifiIface && await this._isAPActive();
    const canRescan = !!this.clientIface || !apOnScanIface;

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
   * The interface a client connection should use.
   *
   * Roles invert under BLE onboarding (§8.2): the best radio becomes the
   * client, because once a phone does setup over Bluetooth a USB dongle is no
   * longer there to free the onboard chip — it is there because somebody
   * wanted WiFi 6, which neither onboard radio has. So the dongle is the
   * client when present, and otherwise the onboard chip is.
   */
  async _clientIfaceForConnect() {
    await this._ensureIface();
    if (!this.clientIface) this.clientIface = await this._findClientIface();
    return this.clientIface || this.wifiIface;
  }

  /**
   * Free the radio so it can associate as a client.
   *
   * Only ever needed when the client interface IS the AP interface — one
   * radio, hotspot on it. On the N97 that is unavoidable (§3.3: the driver
   * supports no interface combination at all); on the N100 a future on-demand
   * hotspot can use a second virtual interface instead.
   *
   * Refuses in `hotspot` onboarding mode, because there the hotspot is how
   * somebody is talking to this box and taking it down would strand them
   * mid-request.
   */
  async _releaseRadioForClient(iface) {
    if (iface !== this.wifiIface) return { released: false, apWasUp: false };
    if (!(await this._isAPActive())) return { released: false, apWasUp: false };

    if (this.onboardingMode === 'hotspot') {
      return {
        released: false,
        apWasUp: true,
        refused: 'This camera is set up over its own hotspot, so it cannot use '
               + 'that radio to join a network. Plug in a USB WiFi adapter or use Ethernet.',
      };
    }

    console.log(`📡 Taking the hotspot down so ${iface} can join a network`);
    // apDesired stops the 30-second health monitor putting it straight back.
    this.apDesired = false;
    await this._runArgs('nmcli', ['connection', 'down', AP_CONNECTION_NAME]);
    // And stop it coming back on the next boot. The hotspot becomes on-demand
    // (§2 D6); dp-hotspot.sh checks ONBOARDING_MODE for the same reason.
    await this._runArgs('nmcli', ['connection', 'modify', AP_CONNECTION_NAME,
                                  'connection.autoconnect', 'no']);
    this.apRunning = false;
    return { released: true, apWasUp: true };
  }

  /**
   * The SSID a NetworkManager profile actually joins.
   *
   * A profile's NAME and its SSID are two different things. They match for
   * profiles this code creates, because connectToNetwork() renames the
   * candidate to the SSID once it works — but not for one made by hand, not
   * for NetworkManager's own auto-suffixed duplicates ("Joe's Bar 1"), and not
   * for anything left behind by an older version. Anything user-facing has to
   * use the SSID; anything passed back to nmcli has to use the name.
   */
  async _profileSsid(profileName) {
    const r = await this._runArgs('nmcli', [
      '-t', '--escape', 'no', '-f', '802-11-wireless.ssid', 'connection', 'show', 'id', profileName,
    ]);
    if (!r.ok) return null;
    const m = r.out.match(/802-11-wireless\.ssid:(.*)/);
    return m ? m[1].trim() : null;
  }

  /** Every saved client WiFi profile, with both its name and its SSID. */
  async _wifiProfiles() {
    const r = await this._runArgs('nmcli', [
      '-t', '--escape', 'no', '-f', 'NAME,TYPE,AUTOCONNECT,TIMESTAMP', 'connection', 'show',
    ]);
    if (!r.ok) return [];
    const rows = [];
    for (const line of r.out.split('\n')) {
      const parts = line.split(':');
      if (parts.length < 4) continue;
      const timestamp = parts.pop();
      const autoconnect = parts.pop();
      const type = parts.pop();
      const profile = parts.join(':');
      if (type !== '802-11-wireless') continue;
      if (profile === AP_CONNECTION_NAME || profile === SETUP_PROFILE) continue;
      rows.push({
        profile,
        ssid: (await this._profileSsid(profile)) || profile,
        autoconnect: autoconnect === 'yes',
        lastUsed: parseInt(timestamp, 10) || 0,
      });
    }
    return rows.sort((a, b) => b.lastUsed - a.lastUsed);
  }

  /** Saved client networks, newest first. Excludes our own hotspot. */
  async savedNetworks() {
    return this._wifiProfiles();
  }

  /**
   * Delete saved profiles for a network.
   *
   * Takes either the SSID or the profile name, because the caller may have
   * either: the app reads whatever net.status reported, and a profile's name
   * need not be its SSID. Deletes every match — NetworkManager happily keeps
   * several profiles for one network, and forgetting a network that comes back
   * on the next boot is not forgetting it.
   */
  async forgetNetwork(ssid) {
    const bad = validateSsid(ssid);
    if (bad) return { success: false, error: bad };
    if (ssid === AP_CONNECTION_NAME) {
      return { success: false, error: 'That is the camera\'s own hotspot' };
    }
    const matches = (await this._wifiProfiles())
      .filter(n => n.ssid === ssid || n.profile === ssid);
    if (matches.length === 0) {
      return { success: false, error: `The camera has no saved network called "${ssid}"` };
    }
    const deleted = [];
    for (const match of matches) {
      const r = await this._runArgs('nmcli', ['connection', 'delete', 'id', match.profile]);
      if (r.ok) deleted.push(match.profile);
    }
    if (deleted.length === 0) {
      return { success: false, error: 'NetworkManager would not delete that profile' };
    }
    return { success: true, deleted };
  }

  /**
   * Join a WiFi network as a client.
   *
   * Three things this does that the previous version did not, all of them
   * because it is now reachable from a phone rather than only from an admin
   * who is already logged in (§8.2):
   *
   *   * **No shell.** Every nmcli call goes through _runArgs().
   *   * **The working network survives a failed attempt.** The candidate is
   *     added under a temporary name and only renamed to the SSID once it is
   *     actually up. Getting a password wrong used to delete the profile the
   *     box was reachable on before finding out.
   *   * **Failures say which failure.** A wrong password, an SSID that is not
   *     there and a DHCP timeout are three different problems for whoever is
   *     standing in the venue, and they used to be one opaque string.
   *
   * Returns { success, code?, error?, ssid, iface, internet }.
   * `onProgress(stage, detail)` is called with `associating`, `dhcp`,
   * `online` / `no-internet`, or `failed`.
   */
  async connectToNetwork(ssid, password, options = {}) {
    const { hidden = false, security = null } = options;
    // Stages come from two places — the explicit calls below and the NM state
    // watcher — and both legitimately see the same transition. The app renders
    // each one, so send a stage only when it actually changes.
    const rawProgress = typeof options.onProgress === 'function'
      ? options.onProgress
      : () => {};
    let lastStage = null;
    const onProgress = (stage, detail) => {
      if (stage === lastStage) return;
      lastStage = stage;
      rawProgress(stage, detail);
    };
    const fail = (code, error) => {
      // `message` not `error`: the app reads data.code and data.message.
      onProgress('failed', { code, message: error, ssid });
      return { success: false, code, error, ssid };
    };

    const badSsid = validateSsid(ssid);
    if (badSsid) return fail('BAD_REQUEST', badSsid);
    const hasPassword = typeof password === 'string' && password.length > 0;
    if (hasPassword) {
      const badPsk = validatePsk(password);
      if (badPsk) return fail('BAD_REQUEST', badPsk);
    }

    const iface = await this._clientIfaceForConnect();
    if (!iface) return fail('WIFI_FAILED', 'This camera has no WiFi adapter');

    // Work out the security type from the scan when the caller did not say.
    // A hidden network is not in the scan, so the caller's hint (or the
    // presence of a password) is all there is.
    let seen = null;
    let scanned = [];
    if (!hidden) {
      try {
        scanned = await this.scanNetworks();
        seen = scanned.find(n => n.ssid === ssid) || null;
      } catch { /* fall through to the hints below */ }
    }
    const keyMgmt = keyMgmtFor(security || (seen && seen.security), hasPassword);

    if (keyMgmt === 'enterprise') {
      return fail('WIFI_FAILED',
        'That network uses WPA-Enterprise, which this camera does not support. Use Ethernet.');
    }
    if (keyMgmt === 'wep') {
      return fail('WIFI_FAILED', 'That network uses WEP, which this camera does not support.');
    }
    if (keyMgmt !== 'none' && !hasPassword) {
      return fail('BAD_REQUEST', 'That network needs a password');
    }
    if (keyMgmt === 'none' && hasPassword) {
      return fail('BAD_REQUEST', 'That network is open and takes no password');
    }
    // An empty scan proves nothing — a radio running the AP cannot rescan — so
    // only refuse when the scan worked and the network genuinely was not in it.
    if (!hidden && !seen && scanned.length > 0) {
      return fail('WIFI_NOT_FOUND', this._describeConnectError('WIFI_NOT_FOUND', ssid));
    }

    const release = await this._releaseRadioForClient(iface);
    if (release.refused) return fail('BUSY', release.refused);

    console.log(`📡 Joining "${ssid}" on ${iface} (${keyMgmt})`);
    onProgress('associating', { ssid, iface });

    // Clear any leftover candidate from an attempt that died mid-flight.
    await this._runArgs('nmcli', ['connection', 'delete', 'id', SETUP_PROFILE]);

    // NOTE: no `ifname`. That would set connection.interface-name and bind the
    // profile to the NIC it was created on, permanently. A box that joined its
    // network through a USB dongle then cannot use that profile once the
    // dongle is removed — NetworkManager will not even attempt it, silently,
    // and the box has no WiFi fallback at all. Found on dp-duocast-85e4 after
    // a power cycle: profile pinned to `wlx6c1ff78a8890`, network in range at
    // full signal, never attempted.
    //
    // The interface is chosen at ACTIVATION instead (`connection up … ifname`
    // below), which targets the right radio now without outliving it.
    const addArgs = [
      'connection', 'add', 'type', 'wifi',
      'con-name', SETUP_PROFILE,
      'ssid', ssid,
      'autoconnect', 'yes',
      '--',
      'connection.autoconnect-priority', '100',
    ];
    if (hidden) addArgs.push('802-11-wireless.hidden', 'yes');
    if (keyMgmt !== 'none') {
      addArgs.push('802-11-wireless-security.key-mgmt', keyMgmt);
      addArgs.push('802-11-wireless-security.psk', password);
    }

    const added = await this._runArgs('nmcli', addArgs);
    if (!added.ok) {
      await this._runArgs('nmcli', ['connection', 'delete', 'id', SETUP_PROFILE]);
      return fail('WIFI_FAILED', this._tidyNmcliError(added.err));
    }

    const stopWatching = this._watchConnectStages(iface, (stage, detail) =>
      onProgress(stage, { ...detail, ssid }));
    const up = await this._runArgs(
      'nmcli', ['--wait', String(CONNECT_WAIT_S), 'connection', 'up', SETUP_PROFILE, 'ifname', iface],
      { timeout: (CONNECT_WAIT_S + 10) * 1000 }
    );
    stopWatching();

    if (!up.ok) {
      await this._runArgs('nmcli', ['connection', 'delete', 'id', SETUP_PROFILE]);
      // Put the hotspot back if we took it down for an attempt that failed —
      // otherwise a wrong password leaves the box with no way in at all.
      // Only where a hotspot is part of the design. Under `ble` there was
      // none to take down, and putting one up now would be the opposite of
      // what the mode means.
      if (release.released && this.onboardingMode !== 'ble') {
        this.apDesired = true;
        await this._runArgs('nmcli', ['connection', 'modify', AP_CONNECTION_NAME,
                                      'connection.autoconnect', 'yes']);
        await this._startAP();
      }
      const code = this._classifyConnectError(up.err, !!seen);
      console.error(`❌ Could not join "${ssid}": ${code} — ${up.err}`);
      return fail(code, this._describeConnectError(code, ssid));
    }

    onProgress('dhcp', { ssid, iface });

    // It is up. Now it is safe to take over the SSID's name: delete every
    // older profile for this network and rename the candidate. Matching on the
    // SSID as well as the name is what stops duplicates accumulating when an
    // old profile was called something else.
    for (const old of await this._wifiProfiles()) {
      if (old.ssid === ssid || old.profile === ssid) {
        await this._runArgs('nmcli', ['connection', 'delete', 'id', old.profile]);
      }
    }
    await this._runArgs('nmcli', ['connection', 'modify', SETUP_PROFILE,
                                  'connection.id', ssid]);
    // Everything else autoconnects at a lower priority, so the network that
    // was just proved wins on the next boot.
    await this._lowerOtherPriorities(ssid);

    const internet = await this._hasInternet();
    // `online` is the one final success stage, with the internet result as a
    // flag on it. A separate "no-internet" stage would read as just another
    // intermediate step to the app and leave it waiting for an end that never
    // came — the box IS on the network, it just cannot reach the outside.
    onProgress('online', { ssid, iface, internet });
    console.log(`✅ Joined "${ssid}" on ${iface}${internet ? '' : ' (no internet yet)'}`);

    return {
      success: true,
      ssid,
      iface,
      internet,
      message: `Connected to ${ssid}`,
      hotspotStopped: release.released,
    };
  }

  /**
   * Report the stages NetworkManager actually goes through while a connection
   * comes up, rather than guessing them from elapsed time.
   *
   * The app distinguishes "associating" from "authenticating" from "dhcp"
   * because they mean different things to somebody standing in the venue: a
   * stall at authenticating is a wrong password, a stall at dhcp is a router
   * problem. Those are real NM device states, so read them.
   *
   * Returns a function that stops the polling.
   */
  _watchConnectStages(iface, onProgress) {
    const STAGES = [
      [40, 'associating'],     // prepare
      [50, 'associating'],     // config
      [60, 'authenticating'],  // need-auth
      [70, 'dhcp'],            // ip-config
      [80, 'dhcp'],            // ip-check
    ];
    const sent = new Set();
    let stopped = false;

    const tick = async () => {
      if (stopped) return;
      const r = await this._runArgs(
        'nmcli', ['-t', '-f', 'GENERAL.STATE', 'device', 'show', iface], { timeout: 4000 }
      );
      if (!stopped && r.ok) {
        const m = r.out.match(/GENERAL\.STATE:\s*(\d+)/);
        if (m) {
          const state = parseInt(m[1], 10);
          for (const [threshold, stage] of STAGES) {
            if (state === threshold && !sent.has(stage)) {
              sent.add(stage);
              onProgress(stage, { ssid: undefined, iface });
            }
          }
        }
      }
      if (!stopped) timer = setTimeout(tick, 700);
    };
    let timer = setTimeout(tick, 300);

    return () => { stopped = true; clearTimeout(timer); };
  }

  /**
   * Map nmcli's failure text onto the §8.2 codes.
   *
   * `wasVisible` is whether the SSID was in the scan we took moments earlier,
   * and it matters more than it looks. A wrong WPA2 password does not reliably
   * produce a secrets error: on several drivers the failed four-way handshake
   * deauthenticates, the AP drops out of NM's view, and NM reports "The Wi-Fi
   * network could not be found". Observed on the N100 on 2026-11-10. Telling
   * somebody to move the camera closer when the real problem is a typo in the
   * password sends them off fixing the wrong thing, so a network we could see
   * seconds ago and now cannot join is treated as an auth failure.
   */
  _classifyConnectError(text, wasVisible = false) {
    const err = (text || '').toLowerCase();
    if (err.includes('secrets were required') || err.includes('no secrets')
        || err.includes('802.1x supplicant') || err.includes('key-mgmt')) {
      return 'WIFI_AUTH_FAILED';
    }
    const notFound = err.includes('no network with ssid')
      || err.includes('could not be found')
      || err.includes('not found')
      || err.includes('no suitable device');
    if (notFound) return wasVisible ? 'WIFI_AUTH_FAILED' : 'WIFI_NOT_FOUND';
    if (err.includes('timeout') || err.includes('timed out')) return 'WIFI_TIMEOUT';
    return 'WIFI_FAILED';
  }

  /** Something a person standing in the venue can act on. */
  _describeConnectError(code, ssid) {
    switch (code) {
      case 'WIFI_AUTH_FAILED':
        return 'That password was not accepted. Check it and try again.';
      case 'WIFI_NOT_FOUND':
        return `The camera could not find "${ssid}". Move it closer to the router.`;
      case 'WIFI_TIMEOUT':
        return 'The network accepted the camera but never gave it an address. '
             + 'The router may be out of addresses, or require a sign-in page.';
      default:
        return `The camera could not join "${ssid}".`;
    }
  }

  _tidyNmcliError(text) {
    return (text || '').replace(/^Error:\s*/i, '').split('\n')[0].trim()
        || 'NetworkManager rejected the connection';
  }

  /**
   * Make the just-proved network the one that wins at boot, without deleting
   * the others — a box moved between two venues should remember both.
   */
  async _lowerOtherPriorities(winner) {
    for (const network of await this._wifiProfiles()) {
      if (network.ssid === winner || network.profile === winner) continue;
      // By profile name: that is what nmcli addresses a connection by.
      await this._runArgs('nmcli', ['connection', 'modify', 'id', network.profile,
                                    'connection.autoconnect-priority', '10']);
    }
  }

  /** A cheap "did that actually get us online" check. */
  async _hasInternet() {
    const r = await this._runArgs('nmcli', ['-t', '-f', 'CONNECTIVITY', 'general', 'status'],
                                  { timeout: 10_000 });
    if (r.ok && /full/i.test(r.out)) return true;
    // NM reports "limited" behind a captive portal and "none" with no route.
    // Fall back to a real request so a working network NM is unsure about
    // still counts.
    const probe = await this._runArgs(
      'curl', ['-s', '-o', '/dev/null', '-m', '5', '-w', '%{http_code}',
               'http://connectivity-check.ubuntu.com/'],
      { timeout: 8_000 }
    );
    return probe.ok && /^(200|204|30\d)$/.test(probe.out);
  }

  /**
   * Leave the current client WiFi network, keeping it saved.
   *
   * Also clears that profile's autoconnect. Without it NetworkManager rejoins
   * within seconds — the profile sits at autoconnect=yes, priority 100 because
   * connectToNetwork() put it there — and a "Disconnect" button that silently
   * undoes itself reads as broken rather than as a policy. The network stays
   * saved, so joining it again is a tap; `wifi.forget` is the one that removes
   * it.
   *
   * On a box with no Ethernet this takes the camera off the internet. That is
   * the caller's decision to make, so it is reported rather than refused —
   * Bluetooth is still there, which is the whole point of onboarding over it.
   */
  async disconnectFromNetwork() {
    const status = await this.getClientWifiStatus();
    if (!status.available || status.state !== 'connected' || !status.profile) {
      return { success: false, error: 'The camera is not on a WiFi network' };
    }

    const down = await this._runArgs('nmcli', ['connection', 'down', status.profile]);
    if (!down.ok) {
      return { success: false, error: this._tidyNmcliError(down.err) };
    }
    await this._runArgs('nmcli', ['connection', 'modify', 'id', status.profile,
                                  'connection.autoconnect', 'no']);

    const ethernet = await this._hasWiredRoute();
    console.log(`📡 Left "${status.ssid}"${ethernet ? '' : ' — no wired connection, the camera is offline'}`);
    return {
      success: true,
      ssid: status.ssid,
      profile: status.profile,
      // So the app can warn before the user is left with a camera it can only
      // reach over Bluetooth.
      stillOnline: ethernet,
    };
  }

  /** Is there a wired default route? */
  async _hasWiredRoute() {
    const r = await this._runArgs('ip', ['route', 'show', 'default']);
    if (!r.ok) return false;
    return r.out.split('\n').some(line => /\bdev\s+(en|eth)/.test(line));
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
    // Under BLE onboarding there is usually no dongle and the onboard chip is
    // the client (§8.2). Reporting "no WiFi adapter" there made net.status say
    // the camera had no WiFi seconds after it had successfully joined a
    // network — which is the one moment the app most needs the truth.
    let iface = this.clientIface;
    if (!iface && this.wifiIface && !(await this._isAPActive())) {
      iface = this.wifiIface;
    }
    if (!iface) {
      return {
        available: false,
        reason: this.wifiIface
          ? 'The WiFi radio is running the hotspot'
          : 'No WiFi adapter detected',
      };
    }

    const stateR = await this._run(
      `nmcli -t -f GENERAL.STATE,GENERAL.CONNECTION device show "${iface}" 2>/dev/null`
    );
    let state = 'disconnected', profile = null, ssid = null;
    if (stateR.ok) {
      const stateMatch = stateR.out.match(/GENERAL\.STATE:(\d+)/);
      const connMatch  = stateR.out.match(/GENERAL\.CONNECTION:(.*)/);
      if (stateMatch && parseInt(stateMatch[1]) >= 100) state = 'connected';
      if (connMatch && connMatch[1].trim() !== '--') profile = connMatch[1].trim();
    }
    // GENERAL.CONNECTION is the profile NAME. Report the network's real SSID
    // under `ssid` — that is what somebody reads on the screen and what the
    // app shows next to "Forget" — and keep the name under `profile`.
    if (profile) ssid = (await this._profileSsid(profile)) || profile;

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

    return { available: true, iface, state, ssid, profile, ip };
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
    if (this.onboardingMode === 'ble') {
      return false;   // no hotspot in this mode; _startAP() would refuse anyway
    }
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
      // Whether this camera has a hotspot at all. Under BLE onboarding it
      // never raises one (§2 D6), so the admin UI hides its settings rather
      // than offering an SSID and password for an access point that cannot
      // start — _startAP() refuses outright in that mode.
      hotspotAvailable: this.onboardingMode !== 'ble',
      onboardingMode:   this.onboardingMode,
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
