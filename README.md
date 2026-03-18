# Digital Pool Camera Control

A Node.js web service for remotely controlling a USB camera on a Jetson Nano. This service provides a web interface to view the camera stream and control pan, tilt, zoom, and various camera settings using v4l2-ctl commands.

## Features

- 🎥 **Live Video Streaming**: Real-time MJPEG video stream from the USB camera
- 📡 **Professional Streaming**: SRT, RTMP, and UDP streaming with ultra-low latency (~125ms)
- 🕹️ **Pan/Tilt/Zoom Controls**: Intuitive directional pad and zoom controls
- ⚙️ **Camera Settings**: Adjust brightness, contrast, saturation, exposure, white balance, focus, and more
- 🎨 **Custom Graphics Overlay**: Draw custom graphics using Skia Canvas (scores, diagrams, animations)
- 📝 **Text Overlays**: Add custom text, timestamps, and logos to the stream
- 🎮 **Keyboard Controls**: Use arrow keys for quick pan/tilt adjustments
- 🔄 **Real-time Updates**: Socket.IO for instant camera control feedback
- 📱 **Responsive Design**: Works on desktop and mobile devices
- ⚡ **Hardware Acceleration**: NVIDIA hardware encoding on Jetson Nano

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

### Test Graphics Overlay:

To test the graphics overlay feature using **node-canvas**:

1. **Install node-canvas** (if not already installed):

**On Jetson Nano:**
```bash
sudo apt-get install -y build-essential libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev
npm install canvas
```

**On Mac/Linux:**
```bash
npm install canvas
```

2. **Start the main server** (in one terminal):
```bash
npm start
```

3. **Start the test graphics server** (in another terminal):
```bash
node test-graphics.js
```

4. **Enable graphics in the web UI**:
   - Open http://localhost:3000
   - Scroll to "Overlay Settings"
   - Check "🎨 Skia Graphics Overlay"
   - Click "Start Stream"

5. **View the result**:
   - Graphics will be composited into the stream
   - View in OBS: `srt://192.168.1.114:8891`
   - Or view preview: http://localhost:3000

The test graphics show:
- Animated scoreboard
- Pulsing circle
- Rotating square
- Live timestamp

See [GRAPHICS_GUIDE_NODE_CANVAS.md](GRAPHICS_GUIDE_NODE_CANVAS.md) for more details on creating custom graphics.

**Note:** We use **node-canvas** instead of skia-canvas because it's compatible with Node.js 14+ (Jetson Nano). It provides the same HTML5 Canvas API.

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

## 🎨 Custom Graphics with Skia

You can draw custom graphics on your stream using Skia Canvas! Perfect for:
- Score overlays
- Pool table diagrams
- Real-time data visualizations
- Animated graphics

**Quick Start:**

```bash
# Install Skia Canvas
npm install skia-canvas

# Run the example
node examples/skia-graphics-example.js

# View at http://192.168.1.114:8556
```

**See the guides:**
- [SKIA_GRAPHICS_GUIDE.md](SKIA_GRAPHICS_GUIDE.md) - Complete integration guide
- [examples/README.md](examples/README.md) - Example code and patterns

## 📚 Documentation

- [STREAMING_ARCHITECTURE.md](STREAMING_ARCHITECTURE.md) - Streaming system overview
- [SRT_SETUP_GUIDE.md](SRT_SETUP_GUIDE.md) - SRT streaming configuration
- [SKIA_GRAPHICS_GUIDE.md](SKIA_GRAPHICS_GUIDE.md) - Custom graphics overlay guide
- [DEPLOY_TO_JETSON.md](DEPLOY_TO_JETSON.md) - Deployment instructions

## License

ISC

## Author

Tim Traver

## Contributing

Issues and pull requests are welcome!
