# Deploy Graphics Overlay to Jetson

Quick guide to deploy and test the graphics overlay system on your Jetson Nano using **node-canvas**.

## 📦 Step 1: Transfer Files to Jetson

From your Mac:

```bash
rsync -avz --exclude 'node_modules' \
  /Users/timtraver/Projects/digitalpool-camera/ \
  jetson@192.168.1.114:/home/jetson/Desktop/digitalpool-camera/
```

## 🔧 Step 2: Install node-canvas on Jetson

SSH into the Jetson:

```bash
ssh jetson@192.168.1.114
cd ~/Desktop/digitalpool-camera
```

Install system dependencies first:

```bash
sudo apt-get update
sudo apt-get install -y build-essential libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev
```

Install node-canvas:

```bash
npm install canvas
```

**Note:** This may take 5-10 minutes as it compiles native binaries for ARM64.

**Why node-canvas instead of skia-canvas?**
- ✅ Works with Node.js 14+ (skia-canvas requires Node 18+)
- ✅ Fully compatible with Jetson Nano
- ✅ Same HTML5 Canvas API
- ✅ Proven and stable

## ✅ Step 3: Test the Graphics Overlay

Run the example:

```bash
node examples/skia-graphics-example.js
```

You should see:
```
🎨 Initialized Skia canvas: 1920x1080 @ 30fps
🚀 Starting graphics overlay GStreamer pipeline...
✅ Graphics overlay started on port 8556
```

## 🌐 Step 4: View in Browser

From your Mac, open:
```
http://192.168.1.114:8556
```

You should see animated graphics:
- Score board (updating every second)
- Pool table with balls
- Rotating square
- Pulsing circle

## 🎬 Step 5: Test with Video Stream

### Option A: Browser Overlay

1. Start your video stream (SRT or RTMP)
2. Keep the graphics overlay running
3. In your browser, you can layer them using CSS or view separately

### Option B: GStreamer Compositor (Advanced)

This composites graphics directly into the stream. You'll need to modify `streamController.js` to add a `compositor` element.

Example pipeline structure:
```
compositor name=mix
  sink_0::xpos=0 sink_0::ypos=0 sink_0::alpha=1.0
  sink_1::xpos=0 sink_1::ypos=0 sink_1::alpha=0.8
! nvv4l2h264enc ! ...

v4l2src ! ... ! mix.sink_0
tcpclientsrc host=localhost port=8556 ! jpegdec ! videoconvert ! mix.sink_1
```

## 🔍 Troubleshooting

### "Cannot find module 'canvas'"

Install it:
```bash
npm install canvas
```

### Installation fails with "node-gyp" errors

Install build tools:
```bash
sudo apt-get install -y build-essential libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev pkg-config
```

### Graphics not showing

Check if the process is running:
```bash
ps aux | grep node
```

Check if port 8556 is listening:
```bash
sudo netstat -tulpn | grep 8556
```

Test with curl:
```bash
curl -v http://localhost:8556 | head -c 1000
```

You should see binary JPEG data.

### Low framerate

Reduce FPS in your drawing code:
```javascript
overlay.initialize(1920, 1080, 15); // Lower FPS
```

Or reduce resolution:
```javascript
overlay.initialize(1280, 720, 30); // Lower resolution
```

### High CPU usage

- Simplify your drawing function
- Reduce framerate
- Lower resolution
- Cache complex shapes

## 🎨 Customize Your Graphics

Edit `examples/skia-graphics-example.js` or create your own:

```javascript
const GraphicsOverlay = require("../graphicsOverlay");

const overlay = new GraphicsOverlay();
overlay.initialize(1920, 1080, 30);

overlay.setDrawFunction((ctx, frameNumber, timestamp) => {
  ctx.clearRect(0, 0, 1920, 1080);
  
  // Your custom drawing here
  ctx.fillStyle = "white";
  ctx.font = "bold 64px Sans";
  ctx.fillText("Hello from Jetson!", 100, 100);
});

overlay.start(8556);

process.on("SIGINT", () => {
  overlay.stop();
  process.exit(0);
});
```

## 🚀 Run on Startup (Optional)

To run graphics overlay automatically on boot, create a systemd service:

```bash
sudo nano /etc/systemd/system/graphics-overlay.service
```

Add:
```ini
[Unit]
Description=Graphics Overlay Service
After=network.target

[Service]
Type=simple
User=jetson
WorkingDirectory=/home/jetson/Desktop/digitalpool-camera
ExecStart=/usr/bin/node examples/skia-graphics-example.js
Restart=always

[Install]
WantedBy=multi-user.target
```

Enable and start:
```bash
sudo systemctl enable graphics-overlay
sudo systemctl start graphics-overlay
sudo systemctl status graphics-overlay
```

## 📊 Performance Monitoring

Monitor CPU usage:
```bash
top -p $(pgrep -f "skia-graphics-example")
```

Monitor memory:
```bash
free -h
```

Monitor network:
```bash
sudo iftop -i eth0
```

## ✅ Success Checklist

- [ ] Skia Canvas installed successfully
- [ ] Example runs without errors
- [ ] Graphics visible in browser at port 8556
- [ ] Framerate is smooth (check browser console)
- [ ] CPU usage is acceptable (<30%)
- [ ] Can customize drawing function
- [ ] Graphics update in real-time

## 🎉 You're Done!

You now have a working Skia graphics overlay system on your Jetson Nano!

**Next steps:**
- Customize the graphics for your use case
- Integrate with your video stream
- Add real-time data updates
- Create your own drawing functions

See [SKIA_GRAPHICS_GUIDE.md](SKIA_GRAPHICS_GUIDE.md) for more details!

