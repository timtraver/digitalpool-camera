#!/usr/bin/env node

/**
 * Test Graphics Overlay
 *
 * This script runs a simple graphics overlay server for testing.
 * Run this alongside your main server (npm start) to test graphics integration.
 *
 * Usage:
 *   node test-graphics.js
 *
 * Then:
 *   1. Open web UI: http://localhost:3000
 *   2. Enable "Skia Graphics Overlay" in Overlay Settings
 *   3. Start streaming
 *   4. Graphics will be composited into the stream!
 */

const GraphicsOverlay = require("./graphicsOverlay");

console.log("🎨 Starting Graphics Test Server...\n");

// Check if node-canvas is installed
try {
  require("canvas");
  console.log("✅ node-canvas module found");
} catch (err) {
  console.error("❌ node-canvas not installed!");
  console.error("   Install it with: npm install canvas");
  process.exit(1);
}

// Initialize graphics overlay
// Using 5 FPS for smooth updates
const overlay = new GraphicsOverlay();
overlay.initialize(1920, 1080, 5);

console.log("✅ Graphics overlay initialized (1920x1080 @ 5fps)\n");
console.log("💡 Using 5 FPS for smooth real-time updates");

// Set up a test drawing function that updates every frame
overlay.setDrawFunction((ctx, frameNumber, timestamp) => {
  // Clear canvas with transparent background
  ctx.clearRect(0, 0, 1920, 1080);

  // Draw a simple scoreboard
  ctx.fillStyle = "rgba(0, 0, 0, 0.7)";
  ctx.fillRect(50, 50, 500, 200);

  // Draw border
  ctx.strokeStyle = "white";
  ctx.lineWidth = 3;
  ctx.strokeRect(50, 50, 500, 200);

  // Draw title
  ctx.fillStyle = "white";
  ctx.font = "bold 32px Sans";
  ctx.fillText("POOL MATCH - LIVE", 70, 95);

  // Draw score that changes every 5 frames (every second at 5fps)
  const score1 = Math.floor((frameNumber / 5) % 10);
  const score2 = Math.floor((frameNumber / 5) % 8);
  ctx.font = "bold 60px Sans";
  ctx.fillText(`${score1} - ${score2}`, 200, 170);

  // Draw frame counter to show it's updating
  ctx.font = "20px Sans";
  ctx.fillStyle = "rgba(255, 255, 255, 0.6)";
  ctx.fillText(`Frame: ${frameNumber}`, 70, 230);

  // Log every 10th frame to show activity
  if (frameNumber % 10 === 0) {
    console.log(`🎨 Drawing frame ${frameNumber} | Score: ${score1} - ${score2}`);
  }
});

// Start the graphics overlay
overlay.start();

// Show frame count every 2 seconds to see updates
setInterval(() => {
  const score1 = Math.floor((overlay.frameCount / 5) % 10);
  const score2 = Math.floor((overlay.frameCount / 5) % 8);
  console.log(`📊 Frame ${overlay.frameCount} | Score: ${score1} - ${score2}`);
}, 2000);

console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
console.log("🚀 Graphics overlay running!");
console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
console.log(`� Output: /tmp/graphics-overlay.png`);
console.log(`🎬 Resolution: 1920x1080 @ 5fps`);
console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

console.log("📋 Next steps:");
console.log("  1. Open web UI: http://localhost:3000");
console.log("  2. Enable 'Skia Graphics Overlay' in settings");
console.log("  3. Start streaming");
console.log("  4. Graphics will be composited into the stream!\n");

console.log("💡 Performance Tips:");
console.log("   • Currently: 5 FPS (low CPU usage)");
console.log("   • Adjust FPS in line 36 if needed");
console.log("   • Use 2 FPS for scoreboards");
console.log("   • Use 1 FPS for static graphics\n");

console.log("Press Ctrl+C to stop\n");

// Handle graceful shutdown
process.on("SIGINT", () => {
  console.log("\n\n🛑 Stopping graphics overlay...");
  overlay.stop();
  console.log("✅ Graphics overlay stopped");
  process.exit(0);
});

process.on("SIGTERM", () => {
  overlay.stop();
  process.exit(0);
});

