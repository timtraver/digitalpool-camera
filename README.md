# Digital Pool Camera Control

A Node.js web service for remotely controlling a USB camera on a Jetson Nano. This service provides a web interface to view the camera stream and control pan, tilt, zoom, and various camera settings using v4l2-ctl commands.

## Features

- 🎥 **Live Video Streaming**: Real-time MJPEG video stream from the USB camera
- 🕹️ **Pan/Tilt/Zoom Controls**: Intuitive directional pad and zoom controls
- ⚙️ **Camera Settings**: Adjust brightness, contrast, saturation, exposure, white balance, focus, and more
- 🎮 **Keyboard Controls**: Use arrow keys for quick pan/tilt adjustments
- 🔄 **Real-time Updates**: Socket.IO for instant camera control feedback
- 📱 **Responsive Design**: Works on desktop and mobile devices

## Prerequisites

### Hardware

- Jetson Nano (or any Linux system with v4l2 support)
- USB PTZ Camera with v4l2 support

### Software

- Node.js (v14 or higher)
- npm
- ffmpeg
- v4l2-ctl (usually comes with v4l-utils package)

## Installation

1. Clone the repository:

```bash
git clone https://github.com/timtraver/digitalpool-camera.git
cd digitalpool-camera
```

2. Install Node.js dependencies:

```bash
npm install
```

3. Install system dependencies (on Jetson Nano/Ubuntu):

```bash
sudo apt-get update
sudo apt-get install v4l-utils ffmpeg
```

4. Verify your camera is detected:

```bash
v4l2-ctl --list-devices
```

5. Check available camera controls:

```bash
v4l2-ctl -d /dev/video0 --list-ctrls
```

## Configuration

You can configure the service using environment variables:

- `PORT`: Server port (default: 3000)
- `CAMERA_DEVICE`: Camera device path (default: /dev/video0)

Example:

```bash
export PORT=8080
export CAMERA_DEVICE=/dev/video1
```

Or create a `.env` file:

```
PORT=3000
CAMERA_DEVICE=/dev/video0
```

## Usage

### Start the server:

```bash
npm start
```

### Access the web interface:

Open your browser and navigate to:

```
http://localhost:3000
```

Or from another device on the same network:

```
http://<jetson-nano-ip>:3000
```

### Run as a system service (optional):

To run the camera service automatically on boot:

1. Edit the service file:

```bash
nano digitalpool-camera.service
```

2. Update `YOUR_USERNAME` and `/path/to/digitalpool-camera` with your actual values

3. Copy the service file:

```bash
sudo cp digitalpool-camera.service /etc/systemd/system/
```

4. Enable and start the service:

```bash
sudo systemctl enable digitalpool-camera
sudo systemctl start digitalpool-camera
```

5. Check service status:

```bash
sudo systemctl status digitalpool-camera
```

6. View logs:

```bash
sudo journalctl -u digitalpool-camera -f
```

## Camera Controls

### Pan/Tilt/Zoom

- **Directional Pad**: Click arrows to pan/tilt the camera
- **Home Button**: Reset camera to center position
- **Zoom Slider**: Adjust zoom level (0-12)
- **Keyboard**: Use arrow keys for pan/tilt

### Image Quality

- Brightness (0-100)
- Contrast (0-100)
- Saturation (0-100)
- Sharpness (0-100)

### Exposure

- Auto Exposure mode
- Manual exposure time (1-2500)
- Gain (1-128)
- Backlight compensation (0-18)

### White Balance

- Auto white balance toggle
- Manual temperature adjustment (2000-10000K)

### Focus

- Auto focus toggle
- Manual focus adjustment (0-100)

## API Endpoints

### REST API

- `GET /`: Web interface
- `GET /video/stream`: MJPEG video stream
- `GET /api/controls`: Get all camera controls
- `GET /api/control/:name`: Get specific control value
- `POST /api/control/:name`: Set control value (body: `{ "value": <number> }`)

### Socket.IO Events

**Client → Server:**

- `setControl`: Set a camera control `{ control: string, value: number }`
- `getControl`: Get a camera control `{ control: string }`
- `pan`: Pan camera `{ degrees: number }`
- `tilt`: Tilt camera `{ degrees: number }`
- `zoom`: Zoom camera `{ level: number }`
- `resetPosition`: Reset camera to home position

**Server → Client:**

- `controlResult`: Result of control operation `{ success: boolean, ... }`

## Project Structure

```
digitalpool-camera/
├── server.js              # Main Express server with Socket.IO
├── cameraController.js    # Camera control logic using v4l2-ctl
├── package.json           # Node.js dependencies
├── public/                # Static web files
│   ├── index.html        # Web interface
│   ├── app.js            # Client-side JavaScript
│   └── style.css         # Styling
└── README.md             # This file
```

## Troubleshooting

### Camera not detected

```bash
# List all video devices
ls -l /dev/video*

# Check camera capabilities
v4l2-ctl -d /dev/video0 --all
```

### Permission denied

```bash
# Add user to video group
sudo usermod -a -G video $USER
# Log out and log back in
```

### FFmpeg not streaming

- Ensure your camera supports MJPEG format
- Try different video sizes or framerates in server.js
- Check ffmpeg output in server logs

### Controls not working

- Verify the control is supported by your camera
- Check control IDs match your camera's v4l2 controls
- Some controls may be inactive when auto mode is enabled

## Development

To modify camera control definitions, edit the `controls` object in `cameraController.js`.

To change video streaming parameters, modify the ffmpeg arguments in `server.js`.

## License

ISC

## Author

Tim Traver

## Contributing

Issues and pull requests are welcome!
