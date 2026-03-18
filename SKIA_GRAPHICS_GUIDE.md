# Skia Graphics Overlay Guide

This guide shows you how to draw custom graphics on your video stream using Skia Canvas in Node.js.

## 🎨 Overview

The graphics overlay system uses:
- **Skia Canvas** - Real Skia 2D graphics library (same as Chrome/Android)
- **Node.js** - Draw graphics in JavaScript
- **GStreamer** - Composite graphics over video

## 📦 Installation

First, install the `skia-canvas` package on your Jetson:

```bash
cd ~/Desktop/digitalpool-camera
npm install skia-canvas
```

**Note:** `skia-canvas` includes native binaries and may take a few minutes to install on the Jetson.

## 🚀 Quick Start

### 1. Run the Example

```bash
node examples/skia-graphics-example.js
```

This starts a graphics overlay server on port 8556 that draws:
- Animated score board
- Pool table diagram with balls
- Animated shapes

### 2. View the Graphics

Open in your browser:
```
http://192.168.1.114:8556
```

You should see the animated graphics!

## 🎯 Integration with Video Stream

There are two ways to integrate graphics with your video:

### Option A: Overlay Graphics in Browser (Easiest)

Use CSS to overlay the graphics on top of the video in the web preview:

```html
<div style="position: relative;">
  <img src="/video/stream" style="width: 100%;" />
  <img src="http://localhost:8556" style="position: absolute; top: 0; left: 0; width: 100%;" />
</div>
```

### Option B: Composite in GStreamer (Professional)

Use GStreamer's `compositor` element to blend graphics with video before encoding.

**Modified pipeline:**
```bash
gst-launch-1.0 \
  compositor name=mix \
    sink_0::xpos=0 sink_0::ypos=0 sink_0::alpha=1.0 \
    sink_1::xpos=0 sink_1::ypos=0 sink_1::alpha=1.0 \
  ! nvv4l2h264enc ! ... \
  v4l2src ! ... ! mix.sink_0 \
  tcpclientsrc host=localhost port=8556 ! jpegdec ! videoconvert ! mix.sink_1
```

This composites the graphics directly into the encoded stream!

## ✍️ Custom Drawing

### Basic Example

```javascript
const GraphicsOverlay = require("./graphicsOverlay");

const overlay = new GraphicsOverlay();
overlay.initialize(1920, 1080, 30);

overlay.setDrawFunction((ctx, frameNumber, timestamp) => {
  // Clear canvas
  ctx.clearRect(0, 0, 1920, 1080);
  
  // Draw text
  ctx.fillStyle = "white";
  ctx.font = "bold 48px Sans";
  ctx.fillText("Hello Skia!", 100, 100);
  
  // Draw shapes
  ctx.fillStyle = "rgba(255, 0, 0, 0.5)";
  ctx.fillRect(100, 200, 300, 200);
  
  // Draw circles
  ctx.beginPath();
  ctx.arc(500, 300, 50, 0, Math.PI * 2);
  ctx.fill();
});

overlay.start(8556);
```

### Advanced: Real-time Data

```javascript
let currentScore = { player1: 0, player2: 0 };

// Update scores from your app
function updateScore(p1, p2) {
  currentScore = { player1: p1, player2: p2 };
}

overlay.setDrawFunction((ctx, frameNumber, timestamp) => {
  ctx.clearRect(0, 0, 1920, 1080);
  
  // Draw live scores
  ctx.fillStyle = "white";
  ctx.font = "bold 64px Sans";
  ctx.fillText(`${currentScore.player1} - ${currentScore.player2}`, 100, 100);
});
```

## 🎨 Skia Canvas API

The `ctx` object supports the full HTML5 Canvas API plus Skia extensions:

### Drawing Primitives
- `fillRect(x, y, width, height)` - Filled rectangle
- `strokeRect(x, y, width, height)` - Outlined rectangle
- `clearRect(x, y, width, height)` - Clear area
- `arc(x, y, radius, startAngle, endAngle)` - Circle/arc
- `ellipse(x, y, radiusX, radiusY, rotation, startAngle, endAngle)` - Ellipse

### Paths
- `beginPath()` - Start new path
- `moveTo(x, y)` - Move to point
- `lineTo(x, y)` - Line to point
- `bezierCurveTo(cp1x, cp1y, cp2x, cp2y, x, y)` - Bezier curve
- `closePath()` - Close path
- `fill()` - Fill path
- `stroke()` - Stroke path

### Text
- `fillText(text, x, y)` - Draw filled text
- `strokeText(text, x, y)` - Draw outlined text
- `measureText(text)` - Get text metrics

### Styles
- `fillStyle` - Fill color/gradient/pattern
- `strokeStyle` - Stroke color/gradient/pattern
- `lineWidth` - Line width
- `lineCap` - Line cap style
- `lineJoin` - Line join style
- `globalAlpha` - Global opacity (0-1)

### Transformations
- `translate(x, y)` - Move origin
- `rotate(angle)` - Rotate (radians)
- `scale(x, y)` - Scale
- `save()` - Save state
- `restore()` - Restore state

## 📊 Performance Tips

1. **Minimize redraws** - Only redraw what changed
2. **Use transparency wisely** - Fully transparent areas are free
3. **Cache complex shapes** - Draw once, reuse as image
4. **Reduce framerate** - 15-20fps is often enough for overlays
5. **Lower resolution** - 1280x720 graphics on 1920x1080 video works fine

## 🔗 Integration with Video Stream

### ✅ Automatic Integration (Built-in!)

The graphics overlay is **fully integrated** with the streaming system!

**How to use:**
1. Enable "🎨 Skia Graphics Overlay" in the web UI (under Overlay Settings)
2. Set the port (default: 8556) and opacity (0.0-1.0)
3. Start your stream (SRT/RTMP/UDP)
4. Graphics are automatically composited into the video!

**Architecture:**
```
Camera → Text Overlays → Compositor → H.264 Encoder → SRT/RTMP Output
                              ↑
                         Skia Graphics
                         (Port 8556)
```

The compositor blends two video sources:
- **Sink 0**: Camera video (bottom layer, alpha=1.0)
- **Sink 1**: Skia graphics (top layer, alpha=configurable)

### Manual Integration (Advanced)

If you want to integrate manually, add to `server.js`:

```javascript
const GraphicsOverlay = require("./graphicsOverlay");

const graphicsOverlay = new GraphicsOverlay();
graphicsOverlay.initialize(1920, 1080, 30);

// Start graphics when stream starts
streamController.on("started", () => {
  if (streamController.streamConfig.skiaGraphicsEnabled) {
    graphicsOverlay.start(8556);
  }
});

// Stop graphics when stream stops
streamController.on("stopped", () => {
  graphicsOverlay.stop();
});
```

## 📝 Quick Start

1. **Install skia-canvas**: `npm install skia-canvas`
2. **Run the example**: `node examples/skia-graphics-example.js`
3. **View in browser**: `http://192.168.1.114:8556`
4. **Enable in UI**: Check "Skia Graphics Overlay" in web interface
5. **Start streaming**: Graphics will be composited automatically!

## 🎯 Complete Workflow

1. **Create your graphics script** (see `examples/skia-graphics-example.js`)
2. **Start the graphics server**: `node your-graphics-script.js`
3. **Open web UI**: `http://192.168.1.114:3000`
4. **Enable Skia Graphics**: Check the box in Overlay Settings
5. **Start stream**: Click "Start Stream"
6. **View in OBS**: Connect to `srt://192.168.1.114:8891`

Your custom graphics are now part of the live stream! 🎉

Happy drawing! 🎨✨

