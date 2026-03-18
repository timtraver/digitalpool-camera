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
// Using 2 FPS to reduce CPU load - graphics don't need to update that fast!
const overlay = new GraphicsOverlay();
overlay.initialize(1920, 1080, 2);

console.log("✅ Graphics overlay initialized (1920x1080 @ 2fps)\n");
console.log("💡 Using 2 FPS to keep CPU usage very low");

// Set up a VERY simple test drawing function (minimal CPU usage)
overlay.setDrawFunction((ctx, frameNumber, timestamp) => {
  // Clear canvas with transparent background
  ctx.clearRect(0, 0, 1920, 1080);

  // Draw a simple scoreboard (no animations to save CPU)
  ctx.fillStyle = "rgba(0, 0, 0, 0.7)";
  ctx.fillRect(50, 50, 400, 150);

  // Draw border
  ctx.strokeStyle = "white";
  ctx.lineWidth = 2;
  ctx.strokeRect(50, 50, 400, 150);

  // Draw title
  ctx.fillStyle = "white";
  ctx.font = "bold 28px Sans";
  ctx.fillText("POOL MATCH", 70, 90);

  // Draw static score (update every 10 frames to save CPU)
  const score1 = Math.floor((frameNumber / 10) % 10);
  const score2 = Math.floor((frameNumber / 10) % 8);
  ctx.font = "bold 40px Sans";
  ctx.fillText(`${score1} - ${score2}`, 180, 150);
});

// Start the graphics overlay
overlay.start();

// Show frame count every 5 seconds
setInterval(() => {
  const score1 = Math.floor((overlay.frameCount / 10) % 10);
  const score2 = Math.floor((overlay.frameCount / 10) % 8);
  console.log(`📊 Frame ${overlay.frameCount} | Score: ${score1} - ${score2}`);
}, 5000);

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

