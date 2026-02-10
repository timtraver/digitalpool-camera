const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

class CameraController {
    constructor(device = '/dev/video0') {
        this.device = device;
        
        // Camera control definitions based on v4l2-ctl
        this.controls = {
            brightness: { id: '0x00980900', min: 0, max: 100, step: 1, default: 50 },
            contrast: { id: '0x00980901', min: 0, max: 100, step: 1, default: 50 },
            saturation: { id: '0x00980902', min: 0, max: 100, step: 1, default: 50 },
            hue: { id: '0x00980903', min: 0, max: 100, step: 1, default: 50 },
            white_balance_temperature_auto: { id: '0x0098090c', type: 'bool', default: 1 },
            white_balance_red_component: { id: '0x0098090e', min: 0, max: 2048, step: 1, default: 1024 },
            white_balance_blue_component: { id: '0x0098090f', min: 0, max: 2048, step: 1, default: 1024 },
            gain: { id: '0x00980913', min: 1, max: 128, step: 1, default: 1 },
            power_line_frequency: { id: '0x00980918', type: 'menu', min: 0, max: 2, default: 3 },
            white_balance_temperature: { id: '0x0098091a', min: 2000, max: 10000, step: 100, default: 5000 },
            sharpness: { id: '0x0098091b', min: 0, max: 100, step: 1, default: 50 },
            backlight_compensation: { id: '0x0098091c', min: 0, max: 18, step: 1, default: 9 },
            exposure_auto: { id: '0x009a0901', type: 'menu', min: 0, max: 3, default: 0 },
            exposure_absolute: { id: '0x009a0902', min: 1, max: 2500, step: 1, default: 330 },
            pan_absolute: { id: '0x009a0908', min: -468000, max: 468000, step: 3600, default: 0 },
            tilt_absolute: { id: '0x009a0909', min: -324000, max: 324000, step: 3600, default: 0 },
            focus_absolute: { id: '0x009a090a', min: 0, max: 100, step: 1, default: 0 },
            focus_auto: { id: '0x009a090c', type: 'bool', default: 1 },
            zoom_absolute: { id: '0x009a090d', min: 0, max: 12, step: 1, default: 0 },
            zoom_continuous: { id: '0x009a090f', min: 0, max: 100, step: 1, default: 100 },
            pan_speed: { id: '0x009a0920', min: -1, max: 160, step: 1, default: 20 },
            tilt_speed: { id: '0x009a0921', min: -1, max: 120, step: 1, default: 20 }
        };
    }

    /**
     * Set a camera control value
     * @param {string} controlName - Name of the control (e.g., 'brightness', 'pan_absolute')
     * @param {number} value - Value to set
     * @returns {Promise<object>} Result of the operation
     */
    async setControl(controlName, value) {
        try {
            if (!this.controls[controlName]) {
                throw new Error(`Unknown control: ${controlName}`);
            }

            const control = this.controls[controlName];
            
            // Validate value range
            if (control.type !== 'bool' && control.type !== 'menu') {
                if (value < control.min || value > control.max) {
                    throw new Error(`Value ${value} out of range [${control.min}, ${control.max}] for ${controlName}`);
                }
            }

            const command = `v4l2-ctl -d ${this.device} --set-ctrl=${controlName}=${value}`;
            const { stdout, stderr } = await execAsync(command);
            
            return {
                success: true,
                control: controlName,
                value: value,
                message: stdout || 'Control set successfully'
            };
        } catch (error) {
            return {
                success: false,
                control: controlName,
                error: error.message
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
                info: this.controls[controlName]
            };
        } catch (error) {
            return {
                success: false,
                control: controlName,
                error: error.message
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
                output: stdout
            };
        } catch (error) {
            return {
                success: false,
                error: error.message
            };
        }
    }

    /**
     * Pan the camera (relative movement)
     * @param {number} degrees - Degrees to pan (positive = right, negative = left)
     */
    async pan(degrees) {
        const current = await this.getControl('pan_absolute');
        if (current.success) {
            const newValue = current.value + (degrees * 100); // Convert to camera units
            return await this.setControl('pan_absolute', newValue);
        }
        return current;
    }

    /**
     * Tilt the camera (relative movement)
     * @param {number} degrees - Degrees to tilt (positive = up, negative = down)
     */
    async tilt(degrees) {
        const current = await this.getControl('tilt_absolute');
        if (current.success) {
            const newValue = current.value + (degrees * 100); // Convert to camera units
            return await this.setControl('tilt_absolute', newValue);
        }
        return current;
    }

    /**
     * Zoom the camera
     * @param {number} level - Zoom level (0-12)
     */
    async zoom(level) {
        return await this.setControl('zoom_absolute', level);
    }

    /**
     * Reset camera to home position
     */
    async resetPosition() {
        await this.setControl('pan_absolute', 0);
        await this.setControl('tilt_absolute', 0);
        return { success: true, message: 'Camera reset to home position' };
    }
}

module.exports = CameraController;

