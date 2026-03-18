# Testing Skia Graphics Overlay

Quick guide to test the Skia graphics overlay with your video stream.

## 🚀 Quick Start

### Step 1: Install Dependencies

```bash
npm install skia-canvas
```

**Note:** This may take 5-10 minutes on the Jetson Nano as it compiles native binaries.

### Step 2: Start the Main Server

In **Terminal 1**:

```bash
npm start
```

You should see:
```
🚀 Server running on port 3000
📹 Camera device: /dev/video0
✅ Skia graphics overlay module loaded
🎨 Graphics overlay initialized
```

### Step 3: Start the Test Graphics Server

In **Terminal 2**:

```bash
node test-graphics.js
```

You should see:
```
🚀 Graphics overlay server running!
📡 Port: 8556
🌐 View graphics: http://localhost:8556
```

### Step 4: Enable Graphics in Web UI

1. Open browser: `http://localhost:3000` (or `http://192.168.1.114:3000`)
2. Scroll to **"Overlay Settings"**
3. Check **"🎨 Skia Graphics Overlay"**
4. Verify port is **8556**
5. Set opacity to **1.0** (fully opaque)

### Step 5: Start Streaming

1. Click **"Start Stream"** button
2. Graphics will be automatically composited into the stream!

### Step 6: View the Result

**Option A: Web Preview**
- View at: `http://localhost:3000`
- You should see the video with graphics overlaid

**Option B: OBS**
- Add Media Source
- Input: `srt://192.168.1.114:8891`
- You should see the composited stream

## 🎨 What You Should See

The test graphics include:

1. **Scoreboard** (top-left)
   - Semi-transparent black background
   - White border
   - "🎱 TEST GRAPHICS" title
   - Animated score (changes every second)
   - Frame counter

2. **Pulsing Circle** (top-right)
   - Red circle that grows/shrinks
   - Demonstrates animation

3. **Rotating Square** (middle-right)
   - Green square that rotates
   - Demonstrates transformations

4. **Timestamp** (bottom-right)
   - Live clock
   - Updates every frame

## 🔧 Troubleshooting

### Graphics not showing?

**Check if graphics server is running:**
```bash
# In Terminal 2, you should see:
🚀 Graphics overlay server running!
```

**Check if port is listening:**
```bash
sudo netstat -tulpn | grep 8556
```

You should see:
```
tcp  0  0  0.0.0.0:8556  0.0.0.0:*  LISTEN  12345/node
```

**View graphics directly:**

Open in browser: `http://localhost:8556`

You should see the graphics (without video).

### Stream not starting?

**Check GStreamer pipeline:**

Look for this in Terminal 1:
```
🎨 Skia graphics overlay enabled (port 8556, alpha 1.0)
```

**Check for errors:**
```bash
# In Terminal 1, look for:
❌ Failed to start stream
```

If you see errors, the compositor might not be working. Try:
1. Disable Skia graphics in UI
2. Start stream (should work without graphics)
3. Re-enable Skia graphics
4. Restart stream

### Graphics are transparent?

Check the **Opacity** slider in the web UI. Set it to **1.0** for fully opaque graphics.

### Low framerate?

The test graphics run at 30fps. If you see low framerate:
1. Check CPU usage: `top`
2. Reduce graphics complexity
3. Lower framerate in `test-graphics.js`

## 🎯 Next Steps

### Customize the Graphics

Edit `test-graphics.js` and modify the `setDrawFunction` callback:

```javascript
overlay.setDrawFunction((ctx, frameNumber, timestamp) => {
  ctx.clearRect(0, 0, 1920, 1080);
  
  // Your custom drawing here!
  ctx.fillStyle = "white";
  ctx.font = "bold 64px Sans";
  ctx.fillText("Hello World!", 100, 100);
});
```

Restart the graphics server (Ctrl+C, then `node test-graphics.js` again).

### Create Your Own Graphics Script

Copy `test-graphics.js` to a new file:

```bash
cp test-graphics.js my-graphics.js
```

Edit `my-graphics.js` and customize the drawing function.

Run it:
```bash
node my-graphics.js
```

### See More Examples

Check out:
- `examples/skia-graphics-example.js` - More complex example
- `SKIA_GRAPHICS_GUIDE.md` - Complete API reference
- `examples/README.md` - Example patterns

## 📚 Resources

- **Skia Canvas API**: https://github.com/samizdatco/skia-canvas
- **HTML5 Canvas Tutorial**: https://developer.mozilla.org/en-US/docs/Web/API/Canvas_API
- **GStreamer Compositor**: https://gstreamer.freedesktop.org/documentation/compositor/

## ✅ Success Checklist

- [ ] `skia-canvas` installed successfully
- [ ] Main server running (`npm start`)
- [ ] Test graphics server running (`node test-graphics.js`)
- [ ] Graphics visible at `http://localhost:8556`
- [ ] Skia overlay enabled in web UI
- [ ] Stream started successfully
- [ ] Graphics composited into stream
- [ ] Visible in OBS or web preview

🎉 **You're all set!** Now you can create custom graphics for your pool/billiards stream!

