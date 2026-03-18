# Graphics Overlay Performance Guide

Tips for optimizing graphics overlay performance on Jetson Nano.

## 🎯 Recommended Settings

### Framerate Guidelines

Graphics overlays **don't need high framerates**! Here are recommended FPS values:

| Use Case | Recommended FPS | CPU Usage |
|----------|----------------|-----------|
| **Static scoreboard** | 1-2 FPS | Very Low ✅ |
| **Updating scores** | 3-5 FPS | Low ✅ |
| **Smooth animations** | 10-15 FPS | Medium ⚠️ |
| **Fast animations** | 20-30 FPS | High ❌ |

**Default:** We now use **5 FPS** by default, which is perfect for most overlays.

### Resolution Guidelines

| Resolution | Performance | Recommendation |
|------------|-------------|----------------|
| **1920x1080** | Medium | Good for detailed graphics |
| **1280x720** | Fast ✅ | Recommended for Jetson Nano |
| **960x540** | Very Fast ✅ | Good for simple overlays |

## ⚙️ How to Adjust FPS

### In test-graphics.js

```javascript
// Line 36 - Change the third parameter (FPS)
overlay.initialize(1920, 1080, 5);  // 5 FPS (default)

// Examples:
overlay.initialize(1920, 1080, 1);   // 1 FPS - very low CPU
overlay.initialize(1920, 1080, 2);   // 2 FPS - static graphics
overlay.initialize(1920, 1080, 10);  // 10 FPS - smooth updates
```

### In server.js

```javascript
// Line 44 - Change the third parameter (FPS)
graphicsOverlay.initialize(1920, 1080, 5);  // 5 FPS (default)
```

### In your custom script

```javascript
const overlay = new GraphicsOverlay();
overlay.initialize(1920, 1080, 3);  // 3 FPS for your use case
```

## 📊 CPU Usage Examples

On Jetson Nano (1920x1080):

- **1 FPS**: ~2-5% CPU ✅
- **5 FPS**: ~5-10% CPU ✅
- **10 FPS**: ~10-20% CPU ⚠️
- **30 FPS**: ~30-50% CPU ❌

## 🚀 Optimization Tips

### 1. Use Lower FPS for Static Content

If your graphics don't change often (like a scoreboard), use 1-2 FPS:

```javascript
overlay.initialize(1920, 1080, 1);  // Update once per second
```

### 2. Reduce Resolution

Lower resolution = less pixels to draw = faster:

```javascript
// Instead of 1920x1080
overlay.initialize(1280, 720, 5);  // 720p is plenty for overlays
```

### 3. Simplify Your Drawing

**Avoid:**
- Complex gradients
- Many small shapes
- Expensive filters/effects
- Redrawing everything every frame

**Prefer:**
- Solid colors
- Simple shapes
- Minimal text
- Only redraw what changed

### 4. Cache Complex Graphics

If you have complex graphics that don't change, draw them once and reuse:

```javascript
let cachedLogo = null;

overlay.setDrawFunction((ctx, frameNumber, timestamp) => {
  // Only draw logo once
  if (!cachedLogo) {
    const logoCanvas = createCanvas(200, 200);
    const logoCtx = logoCanvas.getContext('2d');
    // ... draw complex logo ...
    cachedLogo = logoCanvas;
  }
  
  // Reuse cached logo
  ctx.drawImage(cachedLogo, 10, 10);
});
```

### 5. Update Only When Needed

Don't redraw if nothing changed:

```javascript
let lastScore = null;

overlay.setDrawFunction((ctx, frameNumber, timestamp) => {
  const currentScore = getScore();  // Your function
  
  // Only redraw if score changed
  if (currentScore !== lastScore) {
    ctx.clearRect(0, 0, 1920, 1080);
    ctx.fillText(`Score: ${currentScore}`, 100, 100);
    lastScore = currentScore;
  }
});
```

## 🔍 Monitoring Performance

### Check CPU Usage

```bash
# On Jetson, while graphics are running:
top -p $(pgrep -f "test-graphics")
```

Look for the `%CPU` column. Aim for <10% CPU usage.

### Check Frame Timing

Add timing to your draw function:

```javascript
overlay.setDrawFunction((ctx, frameNumber, timestamp) => {
  const startTime = Date.now();
  
  // Your drawing code here
  ctx.fillText("Hello", 100, 100);
  
  const drawTime = Date.now() - startTime;
  if (drawTime > 50) {
    console.warn(`Slow frame: ${drawTime}ms`);
  }
});
```

If you see warnings, simplify your drawing or reduce FPS.

## 💡 Real-World Examples

### Pool Scoreboard (Recommended)

```javascript
// 2 FPS is perfect - scores don't change that fast!
overlay.initialize(1920, 1080, 2);

overlay.setDrawFunction((ctx, frameNumber, timestamp) => {
  ctx.clearRect(0, 0, 1920, 1080);
  
  // Simple, efficient drawing
  ctx.fillStyle = "rgba(0, 0, 0, 0.7)";
  ctx.fillRect(50, 50, 400, 150);
  
  ctx.fillStyle = "white";
  ctx.font = "bold 48px Arial";
  ctx.fillText(`Player 1: ${score1}`, 70, 120);
  ctx.fillText(`Player 2: ${score2}`, 70, 180);
});
```

**CPU Usage:** ~3-5% ✅

### Animated Timer

```javascript
// 5 FPS for smooth countdown
overlay.initialize(1920, 1080, 5);

overlay.setDrawFunction((ctx, frameNumber, timestamp) => {
  const seconds = Math.floor((Date.now() - startTime) / 1000);
  
  ctx.clearRect(0, 0, 1920, 1080);
  ctx.fillStyle = "white";
  ctx.font = "bold 64px Arial";
  ctx.fillText(`Time: ${seconds}s`, 100, 100);
});
```

**CPU Usage:** ~5-8% ✅

## ✅ Summary

- **Default FPS is now 5** (was 30) - much better for Jetson Nano!
- **Use 1-2 FPS for static graphics** (scoreboards, labels)
- **Use 3-5 FPS for updating graphics** (timers, scores)
- **Use 10-15 FPS only if you need smooth animations**
- **Never use 30 FPS** unless absolutely necessary
- **Lower resolution if still too slow** (try 1280x720)

Happy optimizing! 🚀✨

