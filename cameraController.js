const { exec } = require("child_process");
const { promisify } = require("util");
const fs = require("fs");
const path = require("path");
const execAsync = promisify(exec);

class CameraController {
  constructor(device = "/dev/video0") {
    this.device = device;
    this.configFile = path.join(__dirname, "camera-config.json");

    // Track pan/tilt positions since camera doesn't report them reliably
    this.currentPan = 0;
    this.currentTilt = 0;

    // Camera control definitions based on v4l2-ctl
    this.controls = {
      brightness: { id: "0x00980900", min: 0, max: 100, step: 1, default: 50 },
      contrast: { id: "0x00980901", min: 0, max: 100, step: 1, default: 50 },
      saturation: { id: "0x00980902", min: 0, max: 100, step: 1, default: 50 },
      hue: { id: "0x00980903", min: 0, max: 100, step: 1, default: 50 },
      white_balance_temperature_auto: {
        id: "0x0098090c",
        type: "bool",
        default: 1,
      },
      white_balance_red_component: {
        id: "0x0098090e",
        min: 0,
        max: 2048,
        step: 1,
        default: 1024,
      },
      white_balance_blue_component: {
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
      exposure_auto: {
        id: "0x009a0901",
        type: "menu",
        min: 0,
        max: 3,
        default: 0,
      },
      exposure_absolute: {
        id: "0x009a0902",
        min: 1,
        max: 2500,
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
      focus_auto: { id: "0x009a090c", type: "bool", default: 1 },
      zoom_absolute: { id: "0x009a090d", min: 0, max: 12, step: 1, default: 0 },
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
        console.log("📋 Config contents:", JSON.stringify(config, null, 2));

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
   * Activate camera by opening the device
   */
  async activateCamera() {
    console.log("📹 Activating camera device...");
    try {
      // Open the camera device briefly to wake it up
      const command = `v4l2-ctl -d ${this.device} --list-formats-ext`;
      await execAsync(command);
      console.log("✅ Camera device activated");

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
    console.log("📋 Config in memory:", JSON.stringify(this.config, null, 2));
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

    // Categorize controls
    for (const [controlName, value] of Object.entries(this.config)) {
      if (ptzControls.includes(controlName)) {
        ptzSettings.push([controlName, value]);
      } else {
        otherControls.push([controlName, value]);
      }
    }

    // Apply non-PTZ controls first
    console.log("  📷 Applying image quality and exposure settings...");
    for (const [controlName, value] of otherControls) {
      if (this.controls[controlName]) {
        try {
          console.log(`  ⚙️  Setting ${controlName} = ${value}`);
          const result = await this.setControl(controlName, value, false);
          results.push({ control: controlName, ...result });

          if (result.success) {
            console.log(`  ✅ ${controlName} set successfully`);
          } else {
            console.log(`  ❌ ${controlName} failed: ${result.error}`);
          }

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
      if (this.controls[controlName]) {
        try {
          console.log(`  ⚙️  Setting ${controlName} = ${value}`);
          const result = await this.setControl(controlName, value, false);
          results.push({ control: controlName, ...result });

          // Update tracked positions for pan/tilt
          if (controlName === "pan_absolute") {
            this.currentPan = value;
          } else if (controlName === "tilt_absolute") {
            this.currentTilt = value;
          }

          if (result.success) {
            console.log(`  ✅ ${controlName} set successfully`);
          } else {
            console.log(`  ❌ ${controlName} failed: ${result.error}`);
          }

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
    return await this.applyConfig();
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
      if (!this.controls[controlName]) {
        throw new Error(`Unknown control: ${controlName}`);
      }

      const control = this.controls[controlName];

      // Validate value range
      if (control.type !== "bool" && control.type !== "menu") {
        if (value < control.min || value > control.max) {
          throw new Error(
            `Value ${value} out of range [${control.min}, ${control.max}] for ${controlName}`,
          );
        }
      }

      const command = `v4l2-ctl -d ${this.device} --set-ctrl=${controlName}=${value}`;
      console.log(`    🔧 Executing: ${command}`);

      const { stdout, stderr } = await execAsync(command);

      // Check for errors in stderr
      if (stderr && stderr.trim().length > 0) {
        console.log(`    ⚠️  stderr: ${stderr}`);
        // Some v4l2-ctl errors go to stderr but don't throw
        if (
          stderr.toLowerCase().includes("error") ||
          stderr.toLowerCase().includes("failed")
        ) {
          throw new Error(stderr);
        }
      }

      if (stdout && stdout.trim().length > 0) {
        console.log(`    📤 stdout: ${stdout}`);
      }

      // Save to config file
      if (saveToConfig) {
        this.config[controlName] = value;
        this.saveConfig();
      }

      return {
        success: true,
        control: controlName,
        value: value,
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
      if (!this.controls[controlName]) {
        throw new Error(`Unknown control: ${controlName}`);
      }

      const command = `v4l2-ctl -d ${this.device} --get-ctrl=${controlName}`;
      const { stdout, stderr } = await execAsync(command);

      // Parse output like "brightness: 50"
      const match = stdout.match(/:\s*(-?\d+)/);
      const value = match ? parseInt(match[1]) : null;

      return {
        success: true,
        control: controlName,
        value: value,
        info: this.controls[controlName],
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
      const command = `v4l2-ctl -d ${this.device} --all`;
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
   * Pan the camera (relative movement)
   * @param {number} degrees - Degrees to pan (positive = right, negative = left)
   */
  async pan(degrees) {
    // Use tracked position instead of querying camera (camera doesn't report reliably)
    // Camera uses step of 3600 units. Based on range (-468000 to 468000),
    // this represents 260 degrees total range (130 degrees each direction).
    // So 3600 units per degree
    const newValue = this.currentPan + degrees * 3600;
    // Clamp to valid range
    const clampedValue = Math.max(
      this.controls.pan_absolute.min,
      Math.min(this.controls.pan_absolute.max, newValue),
    );
    console.log(
      `Pan: current=${this.currentPan}, degrees=${degrees}, new=${newValue}, clamped=${clampedValue}`,
    );

    const result = await this.setControl("pan_absolute", clampedValue);
    if (result.success) {
      this.currentPan = clampedValue;
    }
    return result;
  }

  /**
   * Tilt the camera (relative movement)
   * @param {number} degrees - Degrees to tilt (positive = up, negative = down)
   */
  async tilt(degrees) {
    // Use tracked position instead of querying camera (camera doesn't report reliably)
    // Camera uses step of 3600 units. Based on range (-324000 to 324000),
    // this represents 180 degrees total range (90 degrees each direction).
    // So 3600 units per degree
    const newValue = this.currentTilt + degrees * 3600;
    // Clamp to valid range
    const clampedValue = Math.max(
      this.controls.tilt_absolute.min,
      Math.min(this.controls.tilt_absolute.max, newValue),
    );
    console.log(
      `Tilt: current=${this.currentTilt}, degrees=${degrees}, new=${newValue}, clamped=${clampedValue}`,
    );

    const result = await this.setControl("tilt_absolute", clampedValue);
    if (result.success) {
      this.currentTilt = clampedValue;
    }
    return result;
  }

  /**
   * Zoom the camera
   * @param {number} level - Zoom level (0-12)
   */
  async zoom(level) {
    return await this.setControl("zoom_absolute", level);
  }

  /**
   * Reset camera to home position
   */
  async resetPosition() {
    await this.setControl("pan_absolute", 0);
    await this.setControl("tilt_absolute", 0);
    // Reset tracked positions
    this.currentPan = 0;
    this.currentTilt = 0;
    return { success: true, message: "Camera reset to home position" };
  }
}

module.exports = CameraController;
