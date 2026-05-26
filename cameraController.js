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
      gain: { id: "0x00980913", min: 1, max: 64, step: 1, default: 1 },
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
      zoom_continuous: {
        id: "0x009a090f",
        min: 0,
        max: 100,
        step: 1,
        default: 100,
      },
      pan_speed: { id: "0x009a0920", min: -1, max: 160, step: 1, default: 20 },
      tilt_speed: { id: "0x009a0921", min: -1, max: 120, step: 1, default: 20 },
    };

    // Load saved configuration
    this.config = this.loadConfig();
  }

  /**
   * Get default values for all controls
   */
  getDefaults() {
    const defaults = {};
    for (const [name, control] of Object.entries(this.controls)) {
      defaults[name] = control.default;
    }
    return defaults;
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

        // Validate and fix invalid values
        let needsSave = false;
        for (const [controlName, value] of Object.entries(config)) {
          if (this.controls[controlName]) {
            const control = this.controls[controlName];
            // Check if value is out of range
            if (control.type !== "bool" && control.type !== "menu") {
              if (value < control.min || value > control.max) {
                console.log(
                  `⚠️  Invalid value for ${controlName}: ${value} (range: ${control.min}-${control.max}), using default: ${control.default}`,
                );
                config[controlName] = control.default;
                needsSave = true;
              }
            } else if (control.type === "menu") {
              if (value < control.min || value > control.max) {
                console.log(
                  `⚠️  Invalid value for ${controlName}: ${value} (range: ${control.min}-${control.max}), using default: ${control.default}`,
                );
                config[controlName] = control.default;
                needsSave = true;
              }
            }
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
      const { stdout } = await execAsync(
        `v4l2-ctl -d ${dev} --list-ctrls 2>/dev/null`,
        { timeout: 5000 }
      );
      const discovered = {};
      // Example line:
      //   brightness 0x00980900 (int)    : min=0 max=14 step=1 default=7 value=7
      const lineRe = /^\s+(\w+)\s+0x[0-9a-f]+\s+\((\w+)\)\s*:(.+)$/;
      for (const line of stdout.split('\n')) {
        const m = line.match(lineRe);
        if (!m) continue;
        const [, name, type, attrs] = m;
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
            step: 1, default: num('default') ?? 0,
          };
        }
      }
      console.log(`📷 Camera controls discovered: ${Object.keys(discovered).join(', ')}`);
      this.discoveredControls = discovered;
      return discovered;
    } catch (err) {
      console.warn('⚠️  Could not discover camera controls:', err.message);
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
    const { min = 0, max = 100 } = hwControl;
    if (CameraController.PERCENTAGE_CONTROLS.has(controlName)) {
      const fraction = Math.max(0, Math.min(100, configValue)) / 100;
      return Math.round(min + fraction * (max - min));
    }
    // Direct value — clamp to hardware range
    return Math.max(min, Math.min(max, configValue));
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
    const autoModeControls = [
      "white_balance_automatic",
      "auto_exposure",
      "focus_automatic_continuous",
    ];
    const autoControls = [];

    // Categorize controls
    for (const [controlName, value] of Object.entries(this.config)) {
      if (ptzControls.includes(controlName)) {
        ptzSettings.push([controlName, value]);
      } else if (autoModeControls.includes(controlName)) {
        autoControls.push([controlName, value]);
      } else {
        otherControls.push([controlName, value]);
      }
    }

    // Use discovered hardware controls if available, fall back to static map.
    const hwControls = this.discoveredControls || this.controls;

    // Apply auto-mode controls first (disable auto before setting manual values)
    for (const [controlName, value] of autoControls) {
      if (hwControls[controlName]) {
        try {
          const result = await this.setControl(controlName, value, false);
          results.push({ control: controlName, ...result });
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
    // auto_exposure: 0=Auto, 1=Manual, 3=Aperture Priority
    if (expAuto === 0 || expAuto === 3) {
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

    console.log("✅ Camera configuration applied");
    return results;
  }

  /**
   * Reset all controls to defaults and save
   */
  async resetToDefaults() {
    console.log("🔄 Resetting camera to default values...");
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

      // Translate the stored UI value (0-100 for percentage controls, raw for
      // PTZ controls) to the camera's actual hardware range.
      const hwValue = this.translateValue(controlName, value, hwControl);

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

      // Save the original UI value (not the translated hw value) to config
      // so the slider position is preserved across reboots.
      if (saveToConfig) {
        this.config[controlName] = value;
        this.saveConfig();
      }

      return {
        success: true,
        control: controlName,
        value,
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
   * Zoom the camera
   * @param {number} level - Zoom level (0-100)
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
   * Apply the startup position to the camera (pan/tilt/zoom only)
   */
  async applyStartupPosition() {
    const startupPos = this.loadStartupPosition();
    if (!startupPos) {
      console.log("📌 No startup position set, using saved config position");
      return false;
    }
    console.log("📌 Applying startup position:", startupPos);
    await this.setControl("pan_absolute", startupPos.pan_absolute);
    await this.setControl("tilt_absolute", startupPos.tilt_absolute);
    await this.setControl("zoom_absolute", startupPos.zoom_absolute);
    this.currentPan = startupPos.pan_absolute;
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
      return { success: true, message: "Camera reset to startup position" };
    }
    await this.setControl("pan_absolute", 0);
    await this.setControl("tilt_absolute", 0);
    // Reset tracked positions
    this.currentPan = 0;
    this.currentTilt = 0;
    return { success: true, message: "Camera reset to home position" };
  }
}

// Controls where the config/UI stores a 0-100 percentage value that must be
// scaled to the camera's actual hardware range before applying via v4l2-ctl.
// PTZ absolute controls (pan_absolute, tilt_absolute) are NOT in this set —
// they store raw camera-unit values and are clamped to the hardware range.
CameraController.PERCENTAGE_CONTROLS = new Set([
  'brightness', 'contrast', 'saturation', 'hue', 'sharpness', 'gamma',
  'zoom_absolute',
]);

module.exports = CameraController;
