# Graphics Overlay Examples

This directory contains examples for drawing custom graphics on your video stream using Skia Canvas.

## 📋 Prerequisites

Install the required package:

```bash
npm install skia-canvas
```

**Note:** This may take a few minutes on the Jetson Nano as it includes native binaries.

## 🎨 Examples

### 1. Basic Skia Graphics Example

**File:** `skia-graphics-example.js`

**What it does:**
- Draws an animated score board
- Renders a pool table with balls
- Shows animated shapes (rotating square, pulsing circle)

**Run it:**
```bash
node examples/skia-graphics-example.js
```

**View it:**
```
http://192.168.1.114:8556
```

**What you'll learn:**
- How to initialize the graphics overlay
- How to set a custom drawing function
- How to use Skia Canvas API (shapes, text, colors, animations)
- How to create frame-based animations

## 🚀 Creating Your Own Graphics

### Step 1: Create a new file

```javascript
const GraphicsOverlay = require("../graphicsOverlay");

const overlay = new GraphicsOverlay();
overlay.initialize(1920, 1080, 30); // width, height, fps
```

### Step 2: Define your drawing function

```javascript
overlay.setDrawFunction((ctx, frameNumber, timestamp) => {
  // Clear canvas
  ctx.clearRect(0, 0, 1920, 1080);
  
  // Your custom drawing code here
  ctx.fillStyle = "white";
  ctx.font = "bold 48px Sans";
  ctx.fillText("My Custom Graphics!", 100, 100);
});
```

### Step 3: Start the overlay

```javascript
overlay.start(8556); // Port number

// Handle Ctrl+C
process.on("SIGINT", () => {
  overlay.stop();
  process.exit(0);
});
```

## 💡 Ideas for Custom Graphics

### Pool/Billiards Graphics
- Live score tracking
- Ball positions on table diagram
- Shot clock
- Player names and stats
- Tournament bracket

### Sports Overlays
- Score boards
- Timer/clock
- Player statistics
- Team logos
- Game state indicators

### Data Visualizations
- Real-time charts/graphs
- Progress bars
- Gauges and meters
- Heat maps
- Network diagrams

### Creative Effects
- Particle systems
- Animated backgrounds
- Transitions
- Lower thirds
- Watermarks

## 🎯 Integration Patterns

### Pattern 1: Standalone Graphics Server

Run graphics as a separate service:

```javascript
// graphics-server.js
const overlay = new GraphicsOverlay();
overlay.initialize(1920, 1080, 30);
overlay.setDrawFunction(myDrawFunction);
overlay.start(8556);
```

### Pattern 2: Integrated with Main Server

Add to your main server.js:

```javascript
const GraphicsOverlay = require("./graphicsOverlay");
const graphicsOverlay = new GraphicsOverlay();

// Start/stop with stream
streamController.on("started", () => {
  graphicsOverlay.start(8556);
});

streamController.on("stopped", () => {
  graphicsOverlay.stop();
});
```

### Pattern 3: Real-time Data Updates

Update graphics based on external data:

```javascript
let gameState = { score: 0, time: 0 };

// Update from Socket.IO
io.on("connection", (socket) => {
  socket.on("updateScore", (score) => {
    gameState.score = score;
  });
});

// Draw using current state
overlay.setDrawFunction((ctx, frame, time) => {
  ctx.fillText(`Score: ${gameState.score}`, 100, 100);
});
```

## 📚 Resources

- [Skia Canvas Documentation](https://github.com/samizdatco/skia-canvas)
- [HTML5 Canvas API Reference](https://developer.mozilla.org/en-US/docs/Web/API/Canvas_API)
- [SKIA_GRAPHICS_GUIDE.md](../SKIA_GRAPHICS_GUIDE.md) - Full integration guide

## 🐛 Troubleshooting

### "Cannot find module 'skia-canvas'"

Install it:
```bash
npm install skia-canvas
```

### Graphics not showing

1. Check if the overlay is running: `ps aux | grep node`
2. Check if port 8556 is listening: `sudo netstat -tulpn | grep 8556`
3. Try accessing directly: `curl http://localhost:8556`

### Low framerate

Reduce the FPS or simplify your drawing function:
```javascript
overlay.initialize(1920, 1080, 15); // Lower FPS
```

### High CPU usage

- Lower the resolution: `overlay.initialize(1280, 720, 30)`
- Reduce drawing complexity
- Cache complex shapes as images

## 🎬 Next Steps

1. Run the example to see it in action
2. Modify the example to draw your own graphics
3. Integrate with your video stream
4. Add real-time data updates

Happy drawing! 🎨✨

