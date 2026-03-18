/**
 * Example: Custom Graphics Overlay (using node-canvas)
 *
 * This example shows how to draw custom graphics using node-canvas
 * and overlay them on your video stream.
 *
 * Run this example:
 *   node examples/skia-graphics-example.js
 *
 * Then view the graphics at:
 *   http://localhost:8556 (raw graphics stream)
 */

const GraphicsOverlay = require("../graphicsOverlay");

// Create graphics overlay instance
const overlay = new GraphicsOverlay();

// Initialize with your desired resolution and framerate
// Using 5 FPS to reduce CPU load - graphics overlays don't need high framerates!
overlay.initialize(1920, 1080, 5);

// Define your custom drawing function
overlay.setDrawFunction((ctx, frameNumber, timestamp) => {
  // Clear canvas with transparent background
  ctx.clearRect(0, 0, 1920, 1080);
  
  // Example 1: Animated score display
  drawScoreBoard(ctx, frameNumber);
  
  // Example 2: Pool table diagram
  drawPoolTable(ctx, 100, 600);
  
  // Example 3: Animated graphics
  drawAnimatedElement(ctx, frameNumber);
});

/**
 * Example: Draw a score board
 */
function drawScoreBoard(ctx, frame) {
  const x = 50;
  const y = 50;
  const width = 400;
  const height = 150;
  
  // Background with rounded corners
  ctx.fillStyle = "rgba(0, 0, 0, 0.8)";
  ctx.beginPath();
  ctx.roundRect(x, y, width, height, 20);
  ctx.fill();
  
  // Border
  ctx.strokeStyle = "rgba(255, 255, 255, 0.5)";
  ctx.lineWidth = 3;
  ctx.stroke();
  
  // Player names
  ctx.fillStyle = "white";
  ctx.font = "bold 32px Sans";
  ctx.fillText("Player 1", x + 20, y + 50);
  ctx.fillText("Player 2", x + 20, y + 120);
  
  // Scores (animated)
  ctx.font = "bold 48px Sans";
  ctx.fillStyle = "lime";
  const score1 = Math.floor(frame / 30) % 10; // Changes every second
  const score2 = Math.floor(frame / 60) % 10; // Changes every 2 seconds
  ctx.fillText(score1.toString(), x + 320, y + 55);
  ctx.fillText(score2.toString(), x + 320, y + 125);
}

/**
 * Example: Draw a pool table diagram
 */
function drawPoolTable(ctx, x, y) {
  const tableWidth = 400;
  const tableHeight = 200;
  
  // Table felt (green)
  ctx.fillStyle = "rgba(0, 128, 0, 0.8)";
  ctx.fillRect(x, y, tableWidth, tableHeight);
  
  // Table border (wood)
  ctx.strokeStyle = "rgba(139, 69, 19, 0.9)";
  ctx.lineWidth = 10;
  ctx.strokeRect(x, y, tableWidth, tableHeight);
  
  // Pockets (6 pockets)
  ctx.fillStyle = "rgba(0, 0, 0, 0.9)";
  const pocketRadius = 15;
  const pockets = [
    [x, y], // Top-left
    [x + tableWidth / 2, y], // Top-middle
    [x + tableWidth, y], // Top-right
    [x, y + tableHeight], // Bottom-left
    [x + tableWidth / 2, y + tableHeight], // Bottom-middle
    [x + tableWidth, y + tableHeight], // Bottom-right
  ];
  
  pockets.forEach(([px, py]) => {
    ctx.beginPath();
    ctx.arc(px, py, pocketRadius, 0, Math.PI * 2);
    ctx.fill();
  });
  
  // Draw some balls
  drawBall(ctx, x + 100, y + 100, 12, "white"); // Cue ball
  drawBall(ctx, x + 250, y + 100, 12, "red"); // Object ball
  drawBall(ctx, x + 280, y + 90, 12, "yellow");
  drawBall(ctx, x + 280, y + 110, 12, "blue");
}

/**
 * Helper: Draw a pool ball
 */
function drawBall(ctx, x, y, radius, color) {
  // Ball shadow
  ctx.fillStyle = "rgba(0, 0, 0, 0.3)";
  ctx.beginPath();
  ctx.ellipse(x + 2, y + 2, radius, radius * 0.8, 0, 0, Math.PI * 2);
  ctx.fill();
  
  // Ball
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fill();
  
  // Ball highlight
  ctx.fillStyle = "rgba(255, 255, 255, 0.6)";
  ctx.beginPath();
  ctx.arc(x - radius / 3, y - radius / 3, radius / 3, 0, Math.PI * 2);
  ctx.fill();
}

/**
 * Example: Animated element
 */
function drawAnimatedElement(ctx, frame) {
  const x = 1500;
  const y = 200 + Math.sin(frame / 30) * 50; // Bouncing motion
  
  // Rotating square
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate((frame / 60) * Math.PI * 2);
  
  ctx.fillStyle = "rgba(255, 0, 255, 0.7)";
  ctx.fillRect(-50, -50, 100, 100);
  
  ctx.restore();
  
  // Pulsing circle
  const radius = 30 + Math.sin(frame / 15) * 10;
  ctx.fillStyle = "rgba(0, 255, 255, 0.7)";
  ctx.beginPath();
  ctx.arc(x, y + 150, radius, 0, Math.PI * 2);
  ctx.fill();
}

// Start the overlay
console.log("🎨 Starting Skia graphics overlay example...");
console.log("📺 Graphics will be available on port 8556");
console.log("💡 Press Ctrl+C to stop");

overlay.start(8556);

// Handle graceful shutdown
process.on("SIGINT", () => {
  console.log("\n🛑 Shutting down...");
  overlay.stop();
  process.exit(0);
});

