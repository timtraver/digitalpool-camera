# Graphics Overlay Guide (node-canvas)

Complete guide for drawing custom graphics on your video stream using **node-canvas**.

## 🎨 Why node-canvas?

**node-canvas** is perfect for the Jetson Nano because:
- ✅ **Compatible with Node.js 14+** (skia-canvas requires Node 18+)
- ✅ **Cairo-backed** - Proven, stable 2D graphics library
- ✅ **Same API as HTML5 Canvas** - If you know Canvas, you know node-canvas
- ✅ **Works on ARM** - Fully supported on Jetson Nano
- ✅ **Lightweight** - Lower memory footprint than Skia

## 📦 Installation

### On Jetson Nano

```bash
# Install system dependencies
sudo apt-get update
sudo apt-get install -y build-essential libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev

# Install node-canvas
npm install canvas
```

### On Mac/Linux

```bash
npm install canvas
```

## 🚀 Quick Start

### 1. Basic Example

```javascript
const GraphicsOverlay = require("./graphicsOverlay");

const overlay = new GraphicsOverlay();
overlay.initialize(1920, 1080, 30);

overlay.setDrawFunction((ctx, frameNumber, timestamp) => {
  // Clear with transparent background
  ctx.clearRect(0, 0, 1920, 1080);
  
  // Draw text
  ctx.fillStyle = "white";
  ctx.font = "bold 64px Sans";
  ctx.fillText("Hello World!", 100, 100);
});

overlay.start(8556);
```

### 2. Run the Test Server

```bash
node test-graphics.js
```

View at: `http://localhost:8556`

### 3. Enable in Web UI

1. Open `http://localhost:3000`
2. Check "🎨 Skia Graphics Overlay" (name will be updated)
3. Start streaming
4. Graphics are composited into the stream!

## 🎨 Drawing API

node-canvas implements the full HTML5 Canvas 2D API:

### Shapes

```javascript
// Rectangle
ctx.fillRect(x, y, width, height);
ctx.strokeRect(x, y, width, height);

// Circle
ctx.beginPath();
ctx.arc(x, y, radius, 0, Math.PI * 2);
ctx.fill();

// Path
ctx.beginPath();
ctx.moveTo(x1, y1);
ctx.lineTo(x2, y2);
ctx.lineTo(x3, y3);
ctx.closePath();
ctx.stroke();
```

### Text

```javascript
ctx.font = "bold 48px Arial";
ctx.fillStyle = "white";
ctx.fillText("Score: 5-3", 100, 100);

// With shadow
ctx.shadowColor = "black";
ctx.shadowBlur = 10;
ctx.shadowOffsetX = 2;
ctx.shadowOffsetY = 2;
ctx.fillText("Score: 5-3", 100, 100);
```

### Colors & Gradients

```javascript
// Solid color
ctx.fillStyle = "rgba(255, 0, 0, 0.5)";

// Linear gradient
const gradient = ctx.createLinearGradient(0, 0, 200, 0);
gradient.addColorStop(0, "red");
gradient.addColorStop(1, "blue");
ctx.fillStyle = gradient;

// Radial gradient
const radial = ctx.createRadialGradient(100, 100, 10, 100, 100, 100);
radial.addColorStop(0, "white");
radial.addColorStop(1, "black");
ctx.fillStyle = radial;
```

### Transformations

```javascript
// Save state
ctx.save();

// Translate, rotate, scale
ctx.translate(960, 540);  // Move to center
ctx.rotate(Math.PI / 4);  // Rotate 45 degrees
ctx.scale(2, 2);          // Scale 2x

// Draw something
ctx.fillRect(-50, -50, 100, 100);

// Restore state
ctx.restore();
```

### Transparency

```javascript
// Global alpha
ctx.globalAlpha = 0.5;  // 50% transparent

// Per-element alpha
ctx.fillStyle = "rgba(255, 0, 0, 0.5)";  // 50% transparent red
```

## 📊 Example: Pool Scoreboard

```javascript
overlay.setDrawFunction((ctx, frameNumber, timestamp) => {
  ctx.clearRect(0, 0, 1920, 1080);
  
  // Semi-transparent background
  ctx.fillStyle = "rgba(0, 0, 0, 0.7)";
  ctx.fillRect(50, 50, 500, 200);
  
  // Border
  ctx.strokeStyle = "white";
  ctx.lineWidth = 3;
  ctx.strokeRect(50, 50, 500, 200);
  
  // Title
  ctx.fillStyle = "white";
  ctx.font = "bold 32px Arial";
  ctx.fillText("🎱 POOL MATCH", 70, 100);
  
  // Scores (example: update these from your app)
  ctx.font = "bold 64px Arial";
  ctx.fillText("Player 1: 5", 70, 160);
  ctx.fillText("Player 2: 3", 70, 220);
});
```

## 🔄 Real-Time Updates

Update graphics based on external data:

```javascript
let gameState = {
  player1Score: 0,
  player2Score: 0,
  currentPlayer: 1
};

// Function to update scores from your app
function updateScore(p1, p2) {
  gameState.player1Score = p1;
  gameState.player2Score = p2;
}

overlay.setDrawFunction((ctx, frameNumber, timestamp) => {
  ctx.clearRect(0, 0, 1920, 1080);
  
  // Draw live scores
  ctx.fillStyle = "white";
  ctx.font = "bold 64px Arial";
  ctx.fillText(`${gameState.player1Score} - ${gameState.player2Score}`, 100, 100);
  
  // Highlight current player
  if (gameState.currentPlayer === 1) {
    ctx.fillStyle = "yellow";
    ctx.fillRect(50, 50, 20, 80);
  }
});

// Update from your app
updateScore(5, 3);
```

See [TESTING_GRAPHICS.md](TESTING_GRAPHICS.md) for testing instructions and [examples/](examples/) for more examples!

