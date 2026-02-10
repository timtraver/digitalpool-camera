const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const { spawn } = require('child_process');
const path = require('path');
const CameraController = require('./cameraController');

const app = express();
const server = http.createServer(app);
const io = socketIO(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

const PORT = process.env.PORT || 3000;
const CAMERA_DEVICE = process.env.CAMERA_DEVICE || '/dev/video0';

// Initialize camera controller
const camera = new CameraController(CAMERA_DEVICE);

// Serve static files from public directory
app.use(express.static('public'));
app.use(express.json());

// Main page
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// API endpoint to get all controls
app.get('/api/controls', async (req, res) => {
    const result = await camera.getAllControls();
    res.json(result);
});

// API endpoint to get specific control
app.get('/api/control/:name', async (req, res) => {
    const result = await camera.getControl(req.params.name);
    res.json(result);
});

// API endpoint to set control
app.post('/api/control/:name', async (req, res) => {
    const { value } = req.body;
    const result = await camera.setControl(req.params.name, value);
    res.json(result);
});

// Video stream endpoint using MJPEG
app.get('/video/stream', (req, res) => {
    res.writeHead(200, {
        'Content-Type': 'multipart/x-mixed-replace; boundary=frame',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
    });

    // Use ffmpeg to stream from the camera
    const ffmpeg = spawn('ffmpeg', [
        '-f', 'v4l2',
        '-input_format', 'mjpeg',
        '-video_size', '1280x720',
        '-framerate', '30',
        '-i', CAMERA_DEVICE,
        '-f', 'mjpeg',
        '-q:v', '5',
        'pipe:1'
    ]);

    let frameBuffer = Buffer.alloc(0);

    ffmpeg.stdout.on('data', (data) => {
        frameBuffer = Buffer.concat([frameBuffer, data]);

        // Look for JPEG markers
        let start = frameBuffer.indexOf(Buffer.from([0xFF, 0xD8])); // JPEG start
        let end = frameBuffer.indexOf(Buffer.from([0xFF, 0xD9])); // JPEG end

        while (start !== -1 && end !== -1 && end > start) {
            const frame = frameBuffer.slice(start, end + 2);
            res.write(`--frame\r\n`);
            res.write(`Content-Type: image/jpeg\r\n`);
            res.write(`Content-Length: ${frame.length}\r\n\r\n`);
            res.write(frame);
            res.write('\r\n');

            frameBuffer = frameBuffer.slice(end + 2);
            start = frameBuffer.indexOf(Buffer.from([0xFF, 0xD8]));
            end = frameBuffer.indexOf(Buffer.from([0xFF, 0xD9]));
        }
    });

    ffmpeg.stderr.on('data', (data) => {
        console.error(`FFmpeg stderr: ${data}`);
    });

    ffmpeg.on('close', (code) => {
        console.log(`FFmpeg process exited with code ${code}`);
    });

    req.on('close', () => {
        ffmpeg.kill();
    });
});

// Socket.IO for real-time camera control
io.on('connection', (socket) => {
    console.log('Client connected:', socket.id);

    // Handle camera control commands
    socket.on('setControl', async (data) => {
        const { control, value } = data;
        const result = await camera.setControl(control, value);
        socket.emit('controlResult', result);
    });

    socket.on('getControl', async (data) => {
        const { control } = data;
        const result = await camera.getControl(control);
        socket.emit('controlResult', result);
    });

    socket.on('pan', async (data) => {
        const { degrees } = data;
        const result = await camera.pan(degrees);
        socket.emit('controlResult', result);
    });

    socket.on('tilt', async (data) => {
        const { degrees } = data;
        const result = await camera.tilt(degrees);
        socket.emit('controlResult', result);
    });

    socket.on('zoom', async (data) => {
        const { level } = data;
        const result = await camera.zoom(level);
        socket.emit('controlResult', result);
    });

    socket.on('resetPosition', async () => {
        const result = await camera.resetPosition();
        socket.emit('controlResult', result);
    });

    socket.on('disconnect', () => {
        console.log('Client disconnected:', socket.id);
    });
});

server.listen(PORT, () => {
    console.log(`Camera control server running on port ${PORT}`);
    console.log(`Camera device: ${CAMERA_DEVICE}`);
    console.log(`Access the interface at http://localhost:${PORT}`);
});

