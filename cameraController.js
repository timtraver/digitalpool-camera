const { exec } = require("child_process");
const { promisify } = require("util");
const fs = require("fs");
const path = require("path");
const execAsync = promisify(exec);

class CameraController {
  constructor(device = "/dev/video0", options = {}) {
    this.device = device;
    // Controller identity — 1 or 2.  Drives separate config file names so each
    // camera persists its own brightness, PTZ home position, etc.
    this.controllerId = options.controllerId || 1;
    const suffix = this.controllerId === 2 ? "-2" : "";
    this.configFile = path.join(__dirname, `camera-config${suffix}.json`);
    this.startupConfigFile = path.join(__dirname, `camera-startup-config${suffix}.json`);

    // Track pan/tilt positions since camera doesn't report them reliably
    this.currentPan = 0;
    this.currentTilt = 0;

    // Serialization queue for PTZ commands — chaining every pan/tilt call
    // onto this promise prevents concurrent v4l2-ctl processes from racing
    // and reading stale currentPan/currentTilt values out of order.
    this._ptzQueue = Promise.resolve();

    // Populated by discoverControls() after the camera is activated.
    // Contains the real hardware min/max/default for every control the
    // attached camera actually supports.  null until discovery runs.
    this.discoveredControls = null;

    // Camera control definitions based on v4l2-ctl
    // Control names match Orange Pi 5 (mainline kernel 6.11) with OBSBOT Tiny 2 Lite.
    // Used as a fallback when discoveredControls is not yet available.
    this.controls = {
      brightness: { id: "0x00980900", min: 0, max: 100, step: 1, default: 50 },
      contrast: { id: "0x00980901", min: 0, max: 100, step: 1, default: 50 },
      saturation: { id: "0x00980902", min: 0, max: 100, step: 1, default: 50 },
      hue: { id: "0x00980903", min: 0, max: 100, step: 1, default: 50 },
      gamma: { id: "0x00980910", min: 0, max: 100, step: 1, default: 50 },
      white_balance_automatic: {
        id: "0x0098090c",
        type: "bool",
        default: 1,
      },
      red_balance: {
        id: "0x0098090e",
        min: 0,
        max: 2048,
        step: 1,
        default: 1024,
      },
      blue_balance: {
        id: "0x0098090f",
        min: 0,
        max: 2048,
        step: 1,
        default: 1024,
      },
      gain: { id: "0x00980913", min: 1, max: 128, step: 1, default: 1 },
      power_line_frequency: {
        id: "0x00980918",
        type: "menu",
        min: 0,
        max: 2,
        default: 2, // 0=Disabled, 1=50Hz, 2=60Hz
      },
      white_balance_temperature: {
        id: "0x0098091a",
        min: 2000,
        max: 10000,
        step: 100,
        default: 5000,
      },
      sharpness: { id: "0x0098091b", min: 0, max: 100, step: 1, default: 50 },
      backlight_compensation: {
        id: "0x0098091c",
        min: 0,
        max: 18,
        step: 1,
        default: 9,
      },
      auto_exposure: {
        id: "0x009a0901",
        type: "menu",
        min: 0,
        max: 3,
        default: 0, // 0=Auto, 1=Manual, 3=Aperture Priority
      },
      exposure_time_absolute: {
        id: "0x009a0902",
        min: 1,
        max: 2500,  // units = 100 µs; 167=60fps ceiling, 333=30fps ceiling, 2500=4fps (camera drops framerate for longer exposures)
        step: 1,
        default: 330,
      },
      // Whether the sensor may lengthen the frame interval to honor a long
      // exposure.  Pinned to 0 for this appliance — see FORCED_CONTROLS below.
      // With it off, any exposure_time_absolute above the frame period is
      // silently truncated to it — 330 units (33 ms) at 30 fps, 167 (16.7 ms) at
      // 60 fps.  That makes GAIN the only remaining brightness lever, which is
      // why the gain slider must span the camera's real range.  Not every camera
      // exposes this control; it's applied before exposure_time_absolute.
      exposure_dynamic_framerate: {
        id: "0x009a0903",
        type: "bool",
        default: 0,
      },
      pan_absolute: {
        id: "0x009a0908",
        min: -468000,
        max: 468000,
        step: 3600,
        default: 0,
      },
      tilt_absolute: {
        id: "0x009a0909",
        min: -324000,
        max: 324000,
        step: 3600,
        default: 0,
      },
      focus_absolute: {
        id: "0x009a090a",
        min: 0,
        max: 100,
        step: 1,
        default: 0,
      },
      focus_automatic_continuous: { id: "0x009a090c", type: "bool", default: 1 },
      zoom_absolute: { id: "0x009a090d", min: 0, max: 100, step: 1, default: 0 },
      // NOTE: zoom_continuous (0x009a090f) is deliberately NOT here. It is a RATE
      // control (a nonzero value makes the lens keep zooming until stopped), not a
      // position — applying a fixed value at startup would zoom the camera on its
      // own. The UI uses zoom_absolute for positional zoom instead. See
      // NEVER_APPLY_CONTROLS below, which also guards against old saved configs.
      pan_speed: { id: "0x009a0920", min: -1, max: 160, step: 1, default: 20 },
      tilt_speed: { id: "0x009a0921", min: -1, max: 120, step: 1, default: 20 },
    };

    // Load saved configuration
    this.config = this.loadConfig();
  }

  /**
   * Get default values for all controls.
   *
   * Prefers the values the ATTACHED camera reports as its own defaults, falling
   * back to the static OBSBot map only for controls discovery didn't cover.
   * Without this, "Reset All" pushed OBSBot numbers onto every camera — on the
   * ELP 4K U3 that meant gain=1 (its own default is 140 of 0-190) and
   * backlight_compensation=9 (its own default is 48 of 0-160), i.e. reset made
   * the picture darker instead of returning it to the manufacturer's baseline.
   */
  getDefaults() {
    const hw = this.discoveredControls;
    const defaults = {};
    for (const [name, control] of Object.entries(this.controls)) {
      const hwControl = hw && hw[name];
      if (!hwControl || CameraController.ENV_DEFAULT_CONTROLS.has(name)) {
        defaults[name] = control.default;
        continue;
      }
      if (CameraController.PERCENTAGE_CONTROLS.has(name)) {
        // These are stored as 0-100 and scaled at apply time, so express the
        // camera's own default as a percentage of ITS range rather than assuming
        // the midpoint — e.g. ELP saturation defaults to 100 of 0-128 (78%), and
        // a blind 50% left every stream noticeably washed out.
        const { min = 0, max = 100 } = hwControl;
        const d = hwControl.default;
        defaults[name] = (max > min && Number.isFinite(d))
          ? Math.round(((d - min) / (max - min)) * 100)
          : control.default;
      } else if (hwControl.type === 'menu') {
        defaults[name] = this._coerceMenuValue(
          name, hwControl.default ?? control.default, hwControl);
      } else {
        defaults[name] = Number.isFinite(hwControl.default)
          ? hwControl.default
          : control.default;
      }
    }
    return defaults;
  }

  /**
   * Map a requested menu value onto one this camera actually offers.
   *
   * A menu control's min/max spans the whole V4L2 enum, not the subset the
   * camera implements, so the item list is the only reliable guide.  Returns the
   * value unchanged when the camera's items are unknown (no discovery yet).
   */
  _coerceMenuValue(controlName, value, hwControl) {
    const items = hwControl && hwControl.menuItems;
    if (!Array.isArray(items) || items.length === 0) return value;
    const values = items.map((i) => i.value);
    if (values.includes(value)) return value;

    // auto_exposure needs INTENT preserved, not numeric proximity. V4L2 modes:
    // 0=Auto, 1=Manual, 2=Shutter Priority, 3=Aperture Priority. Modes 0 and 3
    // both let the camera choose the exposure time; 1 and 2 both set it by hand.
    // The ELP 4K U3 offers only 1 and 3, so a request for "Auto" (0) must become
    // 3 — picking the numerically nearest value would give 1 (Manual), the exact
    // opposite of what was asked for, and leave the sensor dark.
    if (controlName === 'auto_exposure') {
      const wantAuto = CameraController.isAutoExposureMode(value);
      const sameIntent = values.filter(
        (v) => CameraController.isAutoExposureMode(v) === wantAuto);
      if (sameIntent.length) return sameIntent[0];
    }

    if (values.includes(hwControl.default)) return hwControl.default;
    return values.reduce(
      (best, v) => (Math.abs(v - value) < Math.abs(best - value) ? v : best),
      values[0]);
  }

  /**
   * Load configuration from JSON file
   */
  loadConfig() {
    try {
      if (fs.existsSync(this.configFile)) {
        const data = fs.readFileSync(this.configFile, "utf8");
        let config = JSON.parse(data);
        console.log("✅ Loaded camera config from file:", this.configFile);
        // console.log("📋 Config contents:", JSON.stringify(config, null, 2));

        // Validate and fix invalid values.
        //
        // Only the percentage controls can be checked here: they are 0-100 on
        // every camera by definition.  Everything else stores RAW hardware units
        // whose valid range belongs to the attached camera, and discovery hasn't
        // run yet (this is called from the constructor) — so the only range
        // available would be the static OBSBot fallback, which is simply wrong
        // for another camera.  Validating against it actively destroyed good
        // values: a saved gain of 140 (perfectly valid on the ELP 4K U3's 0-190)
        // is above the OBSBot's max of 128 and was silently reset to 1 on every
        // restart.  setControl() clamps these to the REAL discovered range at
        // apply time instead, and menu values are coerced to a supported item.
        let needsSave = false;
        for (const [controlName, value] of Object.entries(config)) {
          if (!CameraController.PERCENTAGE_CONTROLS.has(controlName)) continue;
          if (value < 0 || value > 100) {
            const fallback = this.controls[controlName]?.default ?? 50;
            console.log(
              `⚠️  Invalid value for ${controlName}: ${value} (must be 0-100), using default: ${fallback}`,
            );
            config[controlName] = fallback;
            needsSave = true;
          }
        }

        // Save corrected config if needed
        if (needsSave) {
          console.log("💾 Saving corrected config...");
          this.config = config;
          this.saveConfig();
        }

        return config;
      } else {
        console.log("⚠️  No camera config file found, using defaults");
      }
    } catch (error) {
      console.error("❌ Error loading camera config file:", error.message);
    }
    // Return defaults if no config file exists
    const defaults = this.getDefaults();
    console.log("📋 Using default config:", JSON.stringify(defaults, null, 2));
    return defaults;
  }

  /**
   * Save configuration to JSON file
   */
  saveConfig() {
    try {
      fs.writeFileSync(
        this.configFile,
        JSON.stringify(this.config, null, 2),
        "utf8",
      );
      console.log("✅ Saved camera config to file:", this.configFile);
      return true;
    } catch (error) {
      console.error("❌ Error saving camera config file:", error.message);
      return false;
    }
  }

  /**
   * Detect whether the camera's primary capture format is MJPEG or YUYV.
   * Returns 'mjpeg' if the device supports MJPEG (uses hardware mppjpegdec path),
   * or 'yuyv' if only raw formats are available (uses videoconvert software path).
   * Defaults to 'mjpeg' on any error so existing MJPEG cameras keep working.
   */
  async detectCaptureFormat(device) {
    const dev = device || this.device;
    try {
      const { stdout } = await execAsync(
        `v4l2-ctl -d ${dev} --list-formats 2>/dev/null`,
        { timeout: 3000 }
      );
      if (/MJPG|JPEG/i.test(stdout)) return 'mjpeg';
      return 'yuyv';
    } catch {
      return 'mjpeg';
    }
  }

  /**
   * Query the camera for all controls it actually supports and store their
   * real hardware ranges in this.discoveredControls.  Called automatically
   * by activateCamera() so that setControl() and applyConfig() can translate
   * stored 0-100 UI values to the correct hardware range for any camera.
   */
  async discoverControls(device) {
    const dev = device || this.device;
    try {
      // --list-ctrls-menus (not --list-ctrls) so the valid ITEMS of each menu
      // control come back too.  A menu's min/max is not a usable range: the ELP
      // 4K U3 reports auto_exposure min=0 max=3 but only offers items 1 (Manual)
      // and 3 (Aperture Priority) — writing 0 or 2 fails.  Only the item list
      // tells us what the camera will actually accept.
      const { stdout } = await execAsync(
        `v4l2-ctl -d ${dev} --list-ctrls-menus 2>/dev/null`,
        { timeout: 5000 }
      );
      const discovered = {};
      // Example line:
      //   brightness 0x00980900 (int)    : min=0 max=14 step=1 default=7 value=7
      const lineRe = /^\s+(\w+)\s+0x[0-9a-f]+\s+\((\w+)\)\s*:(.+)$/;
      // Menu items are indented lines under their menu control, e.g.
      //   				1: Manual Mode
      const menuItemRe = /^\s+(\d+):\s*(\S.*?)\s*$/;
      let lastMenu = null; // control name whose items we're currently collecting
      for (const line of stdout.split('\n')) {
        const m = line.match(lineRe);
        if (!m) {
          // Not a control line — may be a menu item belonging to the previous
          // menu control (or a blank/section-header line, which we ignore).
          const item = lastMenu && line.match(menuItemRe);
          if (item) {
            discovered[lastMenu].menuItems.push({
              value: parseInt(item[1], 10),
              label: item[2],
            });
          }
          continue;
        }
        const [, name, type, attrs] = m;
        lastMenu = null;
        const num = (key) => {
          const hit = attrs.match(new RegExp(`${key}=(-?\\d+)`));
          return hit ? parseInt(hit[1], 10) : undefined;
        };
        if (type === 'int') {
          discovered[name] = {
            min: num('min') ?? 0, max: num('max') ?? 100,
            step: num('step') ?? 1, default: num('default') ?? 0,
          };
        } else if (type === 'bool') {
          discovered[name] = { type: 'bool', default: num('default') ?? 1 };
        } else if (type === 'menu') {
          discovered[name] = {
            type: 'menu', min: num('min') ?? 0, max: num('max') ?? 0,
            step: 1, default: num('default') ?? 0, menuItems: [],
          };
          lastMenu = name;
        }
      }
      console.log(`📷 Camera controls discovered: ${Object.keys(discovered).join(', ')}`);
      // Log the absolute PTZ ranges/steps so the real hardware zoom (and pan/tilt)
      // increments are visible in journalctl — `step` is the smallest change the
      // camera accepts, which is what the UI sliders now move by.
      for (const name of ['zoom_absolute', 'pan_absolute', 'tilt_absolute']) {
        const c = discovered[name];
        if (c) console.log(`   ↳ ${name}: min=${c.min} max=${c.max} step=${c.step}`);
      }
      // Log the brightness-related ranges too — these differ hugely between
      // cameras (OBSBot gain 1-128 vs ELP 4K 0-190) and a UI slider clamped to
      // the wrong maximum is indistinguishable from "the camera is just dark".
      for (const name of ['gain', 'exposure_time_absolute', 'backlight_compensation']) {
        const c = discovered[name];
        if (c) console.log(`   ↳ ${name}: min=${c.min} max=${c.max} default=${c.default}`);
      }
      for (const [name, c] of Object.entries(discovered)) {
        if (c.type === 'menu' && c.menuItems.length) {
          console.log(`   ↳ ${name} accepts: ${c.menuItems.map((i) => `${i.value}=${i.label}`).join(', ')}`);
        }
      }
      this.discoveredControls = discovered;
      return discovered;
    } catch (err) {
      console.warn('⚠️  Could not discover camera controls:', err.message);
      return null;
    }
  }

  /**
   * Work out whether this camera can ACTUALLY pan/tilt/zoom, as opposed to
   * merely advertising the controls.
   *
   * UVC firmware routinely exposes the whole Camera Terminal control set
   * regardless of what is mechanically present, and uvcvideo dutifully creates a
   * v4l2 control for each — so the ELP 4K U3, a fixed camera, offers
   * pan_absolute/tilt_absolute/zoom_absolute and even retains values written to
   * them.  Writing and reading back therefore proves nothing, and neither does
   * the reported range (the ELP's ±648000 is just a generic ±180°).
   *
   * Two signals are worth something:
   *
   *   1. wObjectiveFocalLengthMin/Max in the USB Camera Terminal descriptor.
   *      Per the UVC spec a fixed-focal-length lens reports these equal (often
   *      both 0), so this is a real, spec-backed answer for OPTICAL zoom.  It
   *      lives in the USB descriptor, invisible to v4l2-ctl — hence lsusb.
   *   2. Relative/speed motion controls (pan_speed, tilt_speed, zoom_continuous).
   *      Motorised units generally implement them; the OBSBot does, the ELP does
   *      not.  Correlation only — some genuine PTZ cameras are absolute-only.
   *
   * Neither is conclusive, so this is a DEFAULT, not a verdict: it biases toward
   * keeping PTZ visible and only reports "fixed" on positive evidence.  The user
   * override in the camera source config always wins — see server.js.
   *
   * @returns {Promise<{ptz: boolean, confident: boolean, reason: string}>}
   */
  async detectPtzCapability(device) {
    const dev = device || this.device;
    const hw = this.discoveredControls || {};

    // No absolute pan/tilt/zoom at all → nothing to argue about.
    const hasAbsolute = !!(hw.pan_absolute || hw.tilt_absolute || hw.zoom_absolute);
    if (!hasAbsolute) {
      return { ptz: false, confident: true, reason: "camera exposes no pan/tilt/zoom controls" };
    }

    // Signal 2 — relative motion controls.
    const hasRelative = !!(hw.pan_speed || hw.tilt_speed || hw.zoom_continuous);
    if (hasRelative) {
      return { ptz: true, confident: true, reason: "camera implements relative motion controls (pan_speed/tilt_speed/zoom_continuous)" };
    }

    // Signal 1 — the objective focal length range from the USB descriptor.
    const focal = await this._readObjectiveFocalLength(dev);
    if (focal && focal.min === focal.max) {
      return {
        ptz: false,
        confident: false,
        reason: `fixed lens (wObjectiveFocalLength min=max=${focal.min}) and no relative motion controls`,
      };
    }

    // Absolute controls but no corroborating evidence either way. Assume the
    // camera means it — hiding a working D-pad is worse than showing a dead one.
    return {
      ptz: true,
      confident: false,
      reason: focal
        ? `variable lens (wObjectiveFocalLength ${focal.min}-${focal.max}) but no relative motion controls`
        : "absolute PTZ controls present; USB descriptor unreadable, assuming PTZ",
    };
  }

  /**
   * Work out whether this camera can ACTUALLY autofocus.
   *
   * Focus is mechanical, so it has the same problem as PTZ: the ELP 4K U3 is a
   * manual-focus lens yet advertises both focus_absolute and
   * focus_automatic_continuous, and marks focus_absolute `inactive` while auto
   * focus is "on" — the driver-level plumbing is all present and behaves
   * correctly, there is simply no motor behind it.
   *
   * Detection here is weaker than for PTZ, because the fixed-lens descriptor
   * field only describes focal length (zoom), not focus, and a manual-focus lens
   * has a perfectly good focus ring. So the only confident answer available is
   * the negative one: the camera doesn't advertise focus at all. Everything else
   * defaults to trusting the camera and relies on the operator's override.
   *
   * (Deliberately NOT attempted: sampling focus_absolute over time to see if auto
   * focus hunts. A correctly-focused real AF camera doesn't move either, so that
   * test hides working controls — the failure mode worth avoiding most.)
   *
   * @returns {Promise<{focus: boolean, confident: boolean, reason: string}>}
   */
  async detectFocusCapability() {
    const hw = this.discoveredControls || {};
    const hasAuto = !!hw.focus_automatic_continuous;
    const hasAbsolute = !!hw.focus_absolute;

    if (!hasAuto && !hasAbsolute) {
      return { focus: false, confident: true, reason: "camera exposes no focus controls" };
    }
    // A relative focus control implies a driven focus group rather than a lens
    // the firmware merely knows how to describe.
    if (hw.focus_relative) {
      return { focus: true, confident: true, reason: "camera implements relative focus control" };
    }
    if (hasAuto && !hasAbsolute) {
      return { focus: true, confident: false, reason: "auto focus advertised without a manual focus control" };
    }
    return {
      focus: true,
      confident: false,
      reason: "focus controls advertised, but a manual-focus lens cannot be told apart from a motorised one — set this manually if wrong",
    };
  }

  /**
   * Read wObjectiveFocalLengthMin/Max from the camera's UVC Camera Terminal
   * descriptor.  Needs the USB vendor:product id, which udev knows for the
   * /dev/video node, and root — lsusb only prints descriptors as root, the same
   * reason the v4l2-ctl calls here are sudo'd.  Returns null when unavailable.
   */
  async _readObjectiveFocalLength(dev) {
    try {
      const { stdout: props } = await execAsync(
        `udevadm info -q property -n ${dev} 2>/dev/null`, { timeout: 3000 });
      const vid = props.match(/ID_VENDOR_ID=([0-9a-fA-F]{4})/)?.[1];
      const pid = props.match(/ID_MODEL_ID=([0-9a-fA-F]{4})/)?.[1];
      if (!vid || !pid) return null;

      const { stdout } = await execAsync(
        `sudo lsusb -v -d ${vid}:${pid} 2>/dev/null`, { timeout: 5000, maxBuffer: 4 * 1024 * 1024 });
      const min = stdout.match(/wObjectiveFocalLengthMin\s+(\d+)/)?.[1];
      const max = stdout.match(/wObjectiveFocalLengthMax\s+(\d+)/)?.[1];
      if (min === undefined || max === undefined) return null;
      return { min: parseInt(min, 10), max: parseInt(max, 10) };
    } catch (err) {
      console.warn(`⚠️  Could not read USB descriptor for ${dev}: ${err.message}`);
      return null;
    }
  }

  /**
   * Translate a UI/config value to the camera's actual hardware range.
   *
   * "Percentage controls" (brightness, contrast, zoom, etc.) store a 0-100
   * value in the config so the UI is camera-agnostic.  When applying, we
   * scale that 0-100 value to [hwControl.min, hwControl.max].
   *
   * "Direct controls" (pan_absolute, tilt_absolute) store raw camera-unit
   * values and are clamped to the hardware range without rescaling.
   */
  translateValue(controlName, configValue, hwControl) {
    if (!hwControl || hwControl.type === 'bool') return configValue;
    const { min = 0, max = 100, step = 1 } = hwControl;
    let value;
    if (CameraController.PERCENTAGE_CONTROLS.has(controlName)) {
      // Percentage controls (zoom, brightness, …) store 0-100 in config. Map to
      // the camera's actual [min,max] so 1% always means 1% of THIS camera's
      // range — whether that range is tiny or huge (e.g. a big-zoom PTZ camera).
      const fraction = Math.max(0, Math.min(100, configValue)) / 100;
      value = min + fraction * (max - min);
    } else {
      // Direct value (pan/tilt absolute) — clamp to hardware range.
      value = Math.max(min, Math.min(max, configValue));
    }
    // Snap to the nearest valid increment the camera actually accepts. Cameras
    // advertise a `step` via v4l2-ctl (e.g. zoom in units of 5); sending an
    // off-step value can be rejected or silently rounded, so we honor it here.
    if (step && step > 1) {
      value = min + Math.round((value - min) / step) * step;
    }
    return Math.max(min, Math.min(max, Math.round(value)));
  }

  /**
   * Activate camera by opening the device
   */
  async activateCamera() {
    console.log("📹 Activating camera device...");
    try {
      // Open the camera device briefly to wake it up
      const command = `sudo v4l2-ctl -d ${this.device} --list-formats-ext`;
      await execAsync(command);
      console.log("✅ Camera device activated");

      // Discover the real hardware controls this camera supports so that
      // setControl() and applyConfig() can scale values correctly.
      await this.discoverControls(this.device);

      // Give camera a moment to fully initialize
      await new Promise((resolve) => setTimeout(resolve, 1000));
      return true;
    } catch (error) {
      console.error("⚠️  Failed to activate camera:", error.message);
      return false;
    }
  }

  /**
   * Apply all saved configuration values to the camera
   */
  async applyConfig() {
    console.log("📸 Applying saved camera configuration...");
    const results = [];

    // Separate PTZ controls from other controls
    const ptzControls = [
      "pan_absolute",
      "tilt_absolute",
      "zoom_absolute",
      "pan_speed",
      "tilt_speed",
    ];
    const otherControls = [];
    const ptzSettings = [];

    // Auto/manual mode controls must be applied BEFORE their dependent manual controls.
    // E.g., white_balance_automatic=0 must be set before red_balance, blue_balance,
    // white_balance_temperature. auto_exposure must be set to manual before
    // exposure_time_absolute. focus_automatic_continuous=0 before focus_absolute.
    // exposure_dynamic_framerate belongs here too: it decides whether a long
    // exposure_time_absolute is honored or truncated to the frame period, so it
    // has to be in place before the exposure time is written.
    const autoModeControls = [
      "white_balance_automatic",
      "auto_exposure",
      "exposure_dynamic_framerate",
      "focus_automatic_continuous",
    ];
    const autoControls = [];

    // Categorize controls
    for (const [controlName, value] of Object.entries(this.config)) {
      // Never apply rate/action controls (e.g. zoom_continuous) from config — a
      // fixed nonzero value would make the camera zoom continuously on its own.
      if (CameraController.NEVER_APPLY_CONTROLS.has(controlName)) continue;
      const forced = CameraController.FORCED_CONTROLS.has(controlName)
        ? CameraController.FORCED_CONTROLS.get(controlName)
        : value;
      if (forced !== value) {
        console.log(`  📌 ${controlName} pinned to ${forced} (config had ${value})`);
        this.config[controlName] = forced;
      }
      if (ptzControls.includes(controlName)) {
        ptzSettings.push([controlName, forced]);
      } else if (autoModeControls.includes(controlName)) {
        autoControls.push([controlName, forced]);
      } else {
        otherControls.push([controlName, forced]);
      }
    }

    // Use discovered hardware controls if available, fall back to static map.
    const hwControls = this.discoveredControls || this.controls;

    // Older config files predate the pinned controls and simply lack the key, so
    // the loop above never queued them. Add any that are missing.
    for (const [name, forcedValue] of CameraController.FORCED_CONTROLS) {
      if (name in this.config) continue;
      if (!hwControls[name]) continue;
      console.log(`  📌 ${name} missing from config — applying pinned value ${forcedValue}`);
      this.config[name] = forcedValue;
      if (autoModeControls.includes(name)) autoControls.push([name, forcedValue]);
      else otherControls.push([name, forcedValue]);
    }

    // Apply auto-mode controls first (disable auto before setting manual values)
    let configCorrected = false;
    for (const [controlName, value] of autoControls) {
      if (hwControls[controlName]) {
        try {
          const result = await this.setControl(controlName, value, false);
          results.push({ control: controlName, ...result });
          // A menu value the camera doesn't offer gets remapped to one it does.
          // Store what actually took effect, otherwise config keeps describing a
          // mode this camera has never been in — and the UI, which builds its
          // dropdown from the camera's real modes, cannot represent the stale
          // value and silently displays the wrong one.
          if (result.success && result.value !== value) {
            this.config[controlName] = result.value;
            configCorrected = true;
          }
          await new Promise((resolve) => setTimeout(resolve, 100));
        } catch (error) {
          console.error(`❌ Failed to apply ${controlName}:`, error.message);
          results.push({ control: controlName, success: false, error: error.message });
        }
      }
    }

    // Determine which manual controls to skip based on auto-mode settings.
    // When auto mode is ON, the camera firmware rejects manual overrides.
    const skipControls = new Set();
    const wbAuto = this.config.white_balance_automatic;
    const expAuto = this.config.auto_exposure;
    const focusAuto = this.config.focus_automatic_continuous;

    if (wbAuto === 1 || wbAuto === true) {
      skipControls.add("red_balance");
      skipControls.add("blue_balance");
      skipControls.add("white_balance_temperature");
      console.log("  ℹ️  Auto white balance ON — skipping manual WB controls");
    }
    // Decide against the mode the camera will ACTUALLY be in, not the one stored
    // in config.  A config asking for mode 0 (Auto) on a camera that only offers
    // 1 and 3 gets coerced to 3 by setControl, and testing the raw stored value
    // would have made this branch disagree with the hardware.
    const expMode = this._coerceMenuValue(
      "auto_exposure", expAuto, hwControls.auto_exposure);
    if (CameraController.isAutoExposureMode(expMode)) {
      skipControls.add("exposure_time_absolute");
      console.log("  ℹ️  Auto exposure ON — skipping manual exposure controls");
    }
    if (focusAuto === 1 || focusAuto === true) {
      skipControls.add("focus_absolute");
      console.log("  ℹ️  Auto focus ON — skipping manual focus controls");
    }

    // Then apply non-PTZ manual controls (skipping those blocked by auto modes)
    for (const [controlName, value] of otherControls) {
      if (skipControls.has(controlName)) {
        continue; // Auto mode is on, skip this manual control
      }
      if (hwControls[controlName]) {
        try {
          const result = await this.setControl(controlName, value, false);
          results.push({ control: controlName, ...result });

          await new Promise((resolve) => setTimeout(resolve, 50));
        } catch (error) {
          console.error(`❌ Failed to apply ${controlName}:`, error.message);
          results.push({
            control: controlName,
            success: false,
            error: error.message,
          });
        }
      } else {
        console.log(`  ⚠️  Skipping unknown control: ${controlName}`);
      }
    }

    // Apply PTZ controls last, in specific order
    console.log("  🎥 Applying PTZ (Pan/Tilt/Zoom) settings...");

    // Sort PTZ settings: speeds first, then zoom, then pan/tilt
    const orderedPtzControls = [
      "pan_speed",
      "tilt_speed",
      "zoom_absolute",
      "pan_absolute",
      "tilt_absolute",
    ];
    const sortedPtzSettings = [];

    // Add controls in the specified order
    for (const controlName of orderedPtzControls) {
      const setting = ptzSettings.find(([name]) => name === controlName);
      if (setting) {
        sortedPtzSettings.push(setting);
      }
    }

    for (const [controlName, value] of sortedPtzSettings) {
      if (hwControls[controlName]) {
        try {
          // console.log(`  ⚙️  Setting ${controlName} = ${value}`);
          const result = await this.setControl(controlName, value, false);
          results.push({ control: controlName, ...result });

          // Update tracked positions for pan/tilt
          if (controlName === "pan_absolute") {
            this.currentPan = value;
          } else if (controlName === "tilt_absolute") {
            this.currentTilt = value;
          }

          // if (result.success) {
          //   console.log(`  ✅ ${controlName} set successfully`);
          // } else {
          //   console.log(`  ❌ ${controlName} failed: ${result.error}`);
          // }

          // Longer delay for PTZ commands to allow camera to move
          await new Promise((resolve) => setTimeout(resolve, 500));
        } catch (error) {
          console.error(`❌ Failed to apply ${controlName}:`, error.message);
          results.push({
            control: controlName,
            success: false,
            error: error.message,
          });
        }
      } else {
        console.log(`  ⚠️  Skipping unknown control: ${controlName}`);
      }
    }

    if (configCorrected) {
      console.log("💾 Persisting values the camera remapped…");
      this.saveConfig();
    }

    console.log("✅ Camera configuration applied");
    return results;
  }

  /**
   * Reset all controls to defaults and save.  Also re-runs control discovery
   * so a manual reset doubles as a "re-read camera capabilities" action —
   * useful when a camera was hot-plugged or its driver state was stale at boot.
   */
  async resetToDefaults() {
    console.log("🔄 Resetting camera to default values...");

    // Re-query the device for its real hardware control set/ranges before
    // applyConfig() scales the default values against them.
    this.discoveredControls = null;
    await this.discoverControls(this.device);

    this.config = this.getDefaults();
    this.saveConfig();

    // Also clear the startup/home position so it resets to 0,0,0
    this.clearStartupPosition();

    // Reset tracked positions to defaults
    this.currentPan = 0;
    this.currentTilt = 0;

    return await this.applyConfig();
  }

  /**
   * Clear the saved startup/home position
   */
  clearStartupPosition() {
    try {
      if (fs.existsSync(this.startupConfigFile)) {
        fs.unlinkSync(this.startupConfigFile);
        console.log("📌 Cleared startup position file:", this.startupConfigFile);
      }
    } catch (error) {
      console.error("❌ Error clearing startup position:", error.message);
    }
  }

  /**
   * Set a camera control value
   * @param {string} controlName - Name of the control (e.g., 'brightness', 'pan_absolute')
   * @param {number} value - Value to set
   * @param {boolean} saveToConfig - Whether to save to config file (default: true)
   * @returns {Promise<object>} Result of the operation
   */
  async setControl(controlName, value, saveToConfig = true) {
    try {
      // Prefer the real hardware control map (discovered at runtime) over the
      // static OBSBot-based fallback.  If the control doesn't exist on the
      // attached camera, return gracefully instead of throwing.
      const hwControls = this.discoveredControls || this.controls;
      const hwControl = hwControls[controlName];
      if (!hwControl) {
        return {
          success: false,
          control: controlName,
          error: `Control '${controlName}' not available on this camera`,
        };
      }

      // Menu controls only accept the items the camera implements, so remap an
      // unsupported request onto the closest equivalent this camera does offer
      // (see _coerceMenuValue) rather than letting v4l2-ctl reject it outright.
      let requested = value;
      if (hwControl.type === 'menu') {
        requested = this._coerceMenuValue(controlName, value, hwControl);
        if (requested !== value) {
          const label = hwControl.menuItems?.find((i) => i.value === requested)?.label || requested;
          console.log(`    ↷ ${controlName}=${value} not offered by this camera — using ${requested} (${label})`);
        }
      }

      // Translate the stored UI value (0-100 for percentage controls, raw for
      // PTZ controls) to the camera's actual hardware range.
      const hwValue = this.translateValue(controlName, requested, hwControl);

      const command = `sudo v4l2-ctl -d ${this.device} --set-ctrl=${controlName}=${hwValue}`;
      const note = hwValue !== value ? ` (scaled from ${value})` : '';
      console.log(`    🔧 Executing: ${command}${note}`);

      const { stdout, stderr } = await execAsync(command);

      // Check for errors in stderr — v4l2-ctl may write warnings/errors without
      // using a non-zero exit code (e.g. "unable to set", "VIDIOC_S_CTRL: busy").
      if (stderr && stderr.trim().length > 0) {
        console.log(`    ⚠️  stderr: ${stderr}`);
        throw new Error(stderr.trim());
      }

      if (stdout && stdout.trim().length > 0) {
        console.log(`    📤 stdout: ${stdout}`);
      }

      // Save the UI-level value (not the translated hw value) to config so the
      // slider position is preserved across reboots.  For a coerced menu this is
      // the value the camera actually took, so the dropdown reflects reality
      // instead of a mode this camera doesn't have.
      if (saveToConfig) {
        this.config[controlName] = requested;
        this.saveConfig();
      }

      return {
        success: true,
        control: controlName,
        value: requested,
        hwValue,
        message: stdout || "Control set successfully",
      };
    } catch (error) {
      console.log(`    ❌ Error executing command: ${error.message}`);
      return {
        success: false,
        control: controlName,
        error: error.message,
      };
    }
  }

  /**
   * Get current value of a camera control
   * @param {string} controlName - Name of the control
   * @returns {Promise<object>} Current value and control info
   */
  async getControl(controlName) {
    try {
      const hwControls = this.discoveredControls || this.controls;
      if (!hwControls[controlName]) {
        throw new Error(`Control '${controlName}' not available on this camera`);
      }

      const command = `sudo v4l2-ctl -d ${this.device} --get-ctrl=${controlName}`;
      const { stdout, stderr } = await execAsync(command);

      // Parse output like "brightness: 7"
      const match = stdout.match(/:\s*(-?\d+)/);
      const hwValue = match ? parseInt(match[1]) : null;

      return {
        success: true,
        control: controlName,
        value: hwValue,
        info: hwControls[controlName],
      };
    } catch (error) {
      return {
        success: false,
        control: controlName,
        error: error.message,
      };
    }
  }

  /**
   * Get all current control values
   * @returns {Promise<object>} All control values
   */
  async getAllControls() {
    try {
      const command = `sudo v4l2-ctl -d ${this.device} --all`;
      const { stdout, stderr } = await execAsync(command);

      return {
        success: true,
        output: stdout,
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Sync tracked position with actual camera position
   */
  async syncPosition() {
    try {
      const panResult = await this.getControl("pan_absolute");
      const tiltResult = await this.getControl("tilt_absolute");

      if (panResult.success && panResult.value !== null) {
        this.currentPan = panResult.value;
        console.log(`📍 Synced pan position: ${this.currentPan}`);
      }

      if (tiltResult.success && tiltResult.value !== null) {
        this.currentTilt = tiltResult.value;
        console.log(`📍 Synced tilt position: ${this.currentTilt}`);
      }

      return { success: true, pan: this.currentPan, tilt: this.currentTilt };
    } catch (error) {
      console.error("Failed to sync position:", error.message);
      return { success: false, error: error.message };
    }
  }

  /**
   * Pan the camera by a number of minimum hardware steps.
   * @param {number} steps - Integer steps to move (positive = right, negative = left).
   *                         1 step = hwCtrl.step hardware units — the smallest move
   *                         the motor supports.  The old degrees×3600 conversion is
   *                         gone; working in raw steps is camera-agnostic.
   */
  async pan(steps) {
    // Enqueue — waits for any in-flight pan/tilt to finish before executing.
    const result = await (this._ptzQueue = this._ptzQueue.then(() =>
      this._panImmediate(steps),
    ));
    return result;
  }

  async _panImmediate(steps) {
    const hwControls = this.discoveredControls || this.controls;
    const panCtrl = hwControls.pan_absolute || this.controls.pan_absolute;
    const hwStep = panCtrl.step || 3600; // hardware units per minimum step
    const delta = steps * hwStep;
    const newValue = this.currentPan + delta;
    const clampedValue = Math.max(panCtrl.min, Math.min(panCtrl.max, newValue));
    console.log(
      `🔄 Pan: current=${this.currentPan}, steps=${steps}, hwStep=${hwStep}, delta=${delta}, clamped=${clampedValue}`,
    );

    const result = await this.setControl("pan_absolute", clampedValue);
    if (result.success) {
      this.currentPan = clampedValue;
      console.log(`✅ Pan complete, new position: ${this.currentPan}`);
    }
    return result;
  }

  /**
   * Tilt the camera by a number of minimum hardware steps.
   * @param {number} steps - Integer steps to move (positive = up, negative = down).
   */
  async tilt(steps) {
    // Enqueue — waits for any in-flight pan/tilt to finish before executing.
    const result = await (this._ptzQueue = this._ptzQueue.then(() =>
      this._tiltImmediate(steps),
    ));
    return result;
  }

  async _tiltImmediate(steps) {
    const hwControls = this.discoveredControls || this.controls;
    const tiltCtrl = hwControls.tilt_absolute || this.controls.tilt_absolute;
    const hwStep = tiltCtrl.step || 3600;
    const delta = steps * hwStep;
    const newValue = this.currentTilt + delta;
    const clampedValue = Math.max(tiltCtrl.min, Math.min(tiltCtrl.max, newValue));
    console.log(
      `🔄 Tilt: current=${this.currentTilt}, steps=${steps}, hwStep=${hwStep}, delta=${delta}, clamped=${clampedValue}`,
    );

    const result = await this.setControl("tilt_absolute", clampedValue);
    if (result.success) {
      this.currentTilt = clampedValue;
      console.log(`✅ Tilt complete, new position: ${this.currentTilt}`);
    }
    return result;
  }

  /**
   * Zoom the camera.
   * @param {number} level - RAW hardware zoom value (within the camera's
   *   discovered zoom_absolute min/max). setControl() clamps and snaps it to the
   *   hardware step. The UI slider works in these same raw units so one notch is
   *   the smallest zoom change the camera actually supports.
   */
  async zoom(level) {
    return await this.setControl("zoom_absolute", level);
  }

  /**
   * Save current PTZ position as the startup position
   */
  saveStartupPosition() {
    const position = {
      pan_absolute: this.config.pan_absolute || 0,
      tilt_absolute: this.config.tilt_absolute || 0,
      zoom_absolute: this.config.zoom_absolute || 0,
    };
    try {
      fs.writeFileSync(this.startupConfigFile, JSON.stringify(position, null, 2), "utf8");
      console.log("📌 Saved startup position:", position);
      return { success: true, position };
    } catch (error) {
      console.error("❌ Error saving startup position:", error.message);
      return { success: false, error: error.message };
    }
  }

  /**
   * Load the startup position from file
   * Returns null if no startup position has been set
   */
  loadStartupPosition() {
    try {
      if (fs.existsSync(this.startupConfigFile)) {
        const data = fs.readFileSync(this.startupConfigFile, "utf8");
        const position = JSON.parse(data);
        console.log("📌 Loaded startup position:", position);
        return position;
      }
    } catch (error) {
      console.error("❌ Error loading startup position:", error.message);
    }
    return null;
  }

  /**
   * Wait for the camera's power-on self-home / calibration sweep to finish.
   *
   * Many USB PTZ cameras run a mechanical self-home when first opened; it takes
   * several seconds, during which absolute-position commands are ignored or
   * overridden. If we send the saved home too early it's lost and the camera
   * settles at ITS mechanical home instead of ours. We detect completion by
   * polling pan/tilt until the reported position stops changing (calibration
   * sweep done), after a minimum settle delay and up to a hard timeout.
   */
  async _waitForPtzIdle({ minWaitMs = 2500, maxWaitMs = 12000, sampleMs = 700, stableSamples = 2 } = {}) {
    const t0 = Date.now();
    if (minWaitMs > 0) await new Promise((r) => setTimeout(r, minWaitMs));

    let prev = null;
    let stable = 0;
    while (Date.now() - t0 < maxWaitMs) {
      const pan  = await this.getControl("pan_absolute");
      const tilt = await this.getControl("tilt_absolute");
      if (pan.success && tilt.success && pan.value !== null && tilt.value !== null) {
        if (prev && prev.pan === pan.value && prev.tilt === tilt.value) {
          if (++stable >= stableSamples) {
            console.log(`📌 PTZ settled (pan=${pan.value}, tilt=${tilt.value}) after ${Date.now() - t0}ms — calibration done`);
            return;
          }
        } else {
          stable = 0;
        }
        prev = { pan: pan.value, tilt: tilt.value };
      }
      await new Promise((r) => setTimeout(r, sampleMs));
    }
    console.log(`📌 PTZ settle timed out after ${maxWaitMs}ms — applying home anyway`);
  }

  /**
   * Apply the startup position to the camera (pan/tilt/zoom only)
   */
  async applyStartupPosition() {
    const startupPos = this.loadStartupPosition();
    if (!startupPos) {
      console.log("📌 No startup position set, using saved config position");
      return false;
    }

    // Let any power-on calibration finish first, so the command below isn't
    // discarded by a still-homing camera (which would leave it stuck at the end
    // of its own calibration sweep instead of our saved home).
    await this._waitForPtzIdle();

    console.log("📌 Applying startup position:", startupPos);

    // Many USB PTZ cameras run a mechanical self-home on power-up that takes a
    // few seconds, during which they REJECT or OVERRIDE an absolute-position
    // command.  A single fire-and-forget therefore only works on fast cameras;
    // slow ones finish homing to THEIR default after our command and never reach
    // the saved position.  So send the position, read pan/tilt back, and re-send
    // until the camera actually lands on it (or we run out of attempts) — this
    // lets a still-homing camera finish, then accept the position on a later try.
    const panStep   = (this.discoveredControls?.pan_absolute?.step
                       || this.controls?.pan_absolute?.step || 1);
    const tolerance = Math.max(panStep * 2, 1);
    const maxAttempts = 6;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      await this.setControl("pan_absolute",  startupPos.pan_absolute,  false);
      await this.setControl("tilt_absolute", startupPos.tilt_absolute, false);
      await this.setControl("zoom_absolute", startupPos.zoom_absolute, false);

      // Let the camera move / finish any in-progress self-home before verifying.
      await new Promise((r) => setTimeout(r, 1200));

      const pan  = await this.getControl("pan_absolute");
      const tilt = await this.getControl("tilt_absolute");
      const panOk  = pan.success  && pan.value  !== null && Math.abs(pan.value  - startupPos.pan_absolute)  <= tolerance;
      const tiltOk = tilt.success && tilt.value !== null && Math.abs(tilt.value - startupPos.tilt_absolute) <= tolerance;

      if (panOk && tiltOk) {
        this.currentPan  = pan.value;
        this.currentTilt = tilt.value;
        console.log(`📌 Startup position reached (attempt ${attempt}/${maxAttempts})`);
        return true;
      }
      console.log(`📌 Startup position not reached yet (attempt ${attempt}/${maxAttempts}): ` +
                  `pan ${pan.value}→${startupPos.pan_absolute}, tilt ${tilt.value}→${startupPos.tilt_absolute} — retrying…`);
    }

    console.log("⚠️ Startup position not confirmed after retries — camera may still be busy or not report absolute PTZ");
    this.currentPan  = startupPos.pan_absolute;
    this.currentTilt = startupPos.tilt_absolute;
    return true;
  }

  /**
   * Reset camera to home position (startup position if set, otherwise 0,0,0)
   */
  async resetPosition() {
    const startupPos = this.loadStartupPosition();
    if (startupPos) {
      console.log("🏠 Resetting to startup position:", startupPos);
      await this.setControl("pan_absolute", startupPos.pan_absolute);
      await this.setControl("tilt_absolute", startupPos.tilt_absolute);
      await this.setControl("zoom_absolute", startupPos.zoom_absolute);
      this.currentPan = startupPos.pan_absolute;
      this.currentTilt = startupPos.tilt_absolute;
      // Return the applied position so the UI can sync its sliders (esp. zoom)
      // to the home value — otherwise the slider stays wherever it was.
      return {
        success: true,
        message: "Camera reset to startup position",
        position: {
          pan_absolute:  startupPos.pan_absolute,
          tilt_absolute: startupPos.tilt_absolute,
          zoom_absolute: startupPos.zoom_absolute,
        },
      };
    }
    await this.setControl("pan_absolute", 0);
    await this.setControl("tilt_absolute", 0);
    // Reset tracked positions
    this.currentPan = 0;
    this.currentTilt = 0;
    // No saved home → pan/tilt go to 0 and zoom is left as-is; report the current
    // zoom so the UI stays consistent rather than the slider drifting out of sync.
    return {
      success: true,
      message: "Camera reset to home position",
      position: {
        pan_absolute: 0,
        tilt_absolute: 0,
        zoom_absolute: this.config.zoom_absolute,
      },
    };
  }
}

// Controls where the config/UI stores a 0-100 percentage value that must be
// scaled to the camera's actual hardware range before applying via v4l2-ctl.
// Every OTHER control stores RAW camera-unit values, clamped and step-snapped to
// the discovered hardware range at apply time — that includes the absolute PTZ
// controls and the exposure/gain/white-balance group. Raw is what lets a slider
// move in the camera's own increments: a forced 0-100 percentage produced dead
// zones on small-range cameras and skipped real stops on coarse-step ones.
// The browser sizes each raw slider from the ranges buildControlRanges() sends,
// so this set is also what tells the UI which sliders stay 0-100.
CameraController.PERCENTAGE_CONTROLS = new Set([
  'brightness', 'contrast', 'saturation', 'hue', 'sharpness', 'gamma',
]);

// V4L2 auto_exposure modes: 0=Auto, 1=Manual, 2=Shutter Priority,
// 3=Aperture Priority. Modes 0 and 3 let the camera pick the exposure time;
// 1 and 2 take it from exposure_time_absolute. Cameras implement different
// subsets — the OBSBot offers 0/1/3, the ELP 4K U3 only 1/3 — so never test for
// a specific number when what you mean is "is the camera metering for itself".
CameraController.isAutoExposureMode = (mode) => mode === 0 || mode === 3;

// Controls whose default describes the ENVIRONMENT rather than the camera, so
// getDefaults() keeps this app's value instead of adopting the hardware's.
// power_line_frequency exists to cancel mains flicker: the ELP 4K U3 ships
// defaulted to 50 Hz, and inheriting that would make every North American venue
// flicker under artificial light. The app targets 60 Hz deliberately.
CameraController.ENV_DEFAULT_CONTROLS = new Set([
  'power_line_frequency',
]);

// Rate/action controls that must never be applied from saved config at startup.
// zoom_continuous is a SPEED control (nonzero → the lens keeps zooming until set
// back to 0), so setting it to a stored value would zoom the camera on its own.
// Positional zoom is done via zoom_absolute instead.
CameraController.NEVER_APPLY_CONTROLS = new Set([
  'zoom_continuous',
]);

// Controls pinned to a fixed value regardless of what config says, because this
// appliance's pipeline depends on it.
//
// exposure_dynamic_framerate=1 lets the sensor stretch the frame interval to
// honor a long exposure. On a live stream that means a variable frame rate: the
// output stutters, and it undermines the wall-clock timestamping that
// gst-overlay-pipeline.py forces CLOCK_REALTIME for — long-term A/V sync assumes
// a steady capture rate, and the FPS/drift monitors in streamController read a
// dropping frame rate as a failing pipeline. A brighter picture is not worth
// either, so this is not offered as a user setting; brighten with gain instead.
CameraController.FORCED_CONTROLS = new Map([
  ['exposure_dynamic_framerate', 0],
]);

module.exports = CameraController;
