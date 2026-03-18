#!/usr/bin/env node

/**
 * Test Graphics Overlay
 * 
 * This script runs a simple Skia graphics overlay server for testing.
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

console.log("🎨 Starting Skia Graphics Test Server...\n");

// Check if skia-canvas is installed
try {
  require("skia-canvas");
  console.log("✅ skia-canvas module found");
} catch (err) {
  console.error("❌ skia-canvas not installed!");
  console.error("   Install it with: npm install skia-canvas");
  process.exit(1);
}

// Initialize graphics overlay
const overlay = new GraphicsOverlay();
overlay.initialize(1920, 1080, 30);

console.log("✅ Graphics overlay initialized (1920x1080 @ 30fps)\n");

// Set up a simple test drawing function
overlay.setDrawFunction((ctx, frameNumber, timestamp) => {
  // Clear canvas with transparent background
  ctx.clearRect(0, 0, 1920, 1080);

  // Draw a semi-transparent background for the scoreboard
  ctx.fillStyle = "rgba(0, 0, 0, 0.7)";
  ctx.fillRect(50, 50, 400, 200);

  // Draw border
  ctx.strokeStyle = "white";
  ctx.lineWidth = 3;
  ctx.strokeRect(50, 50, 400, 200);

  // Draw title
  ctx.fillStyle = "white";
  ctx.font = "bold 32px Sans";
  ctx.fillText("🎱 TEST GRAPHICS", 70, 100);

  // Draw animated score
  const score1 = Math.floor((frameNumber / 30) % 10);
  const score2 = Math.floor((frameNumber / 45) % 10);
  ctx.font = "bold 48px Sans";
  ctx.fillText(`${score1} - ${score2}`, 150, 160);

  // Draw frame counter
  ctx.font = "16px Sans";
  ctx.fillStyle = "rgba(255, 255, 255, 0.7)";
  ctx.fillText(`Frame: ${frameNumber}`, 70, 220);

  // Draw animated circle (pulsing)
  const radius = 30 + Math.sin(frameNumber / 10) * 10;
  ctx.fillStyle = "rgba(255, 0, 0, 0.6)";
  ctx.beginPath();
  ctx.arc(1700, 150, radius, 0, Math.PI * 2);
  ctx.fill();

  // Draw rotating square
  const angle = (frameNumber / 30) * Math.PI * 2;
  ctx.save();
  ctx.translate(1700, 300);
  ctx.rotate(angle);
  ctx.fillStyle = "rgba(0, 255, 0, 0.6)";
  ctx.fillRect(-40, -40, 80, 80);
  ctx.restore();

  // Draw timestamp
  const now = new Date();
  ctx.fillStyle = "white";
  ctx.font = "20px Sans";
  ctx.fillText(now.toLocaleTimeString(), 1650, 1050);
});

// Start the graphics server
const PORT = 8556;
overlay.start(PORT);

console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
console.log("🚀 Graphics overlay server running!");
console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
console.log(`📡 Port: ${PORT}`);
console.log(`🌐 View graphics: http://localhost:${PORT}`);
console.log(`🎬 Resolution: 1920x1080 @ 30fps`);
console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

console.log("📋 Next steps:");
console.log("  1. Open web UI: http://localhost:3000");
console.log("  2. Enable 'Skia Graphics Overlay' in Overlay Settings");
console.log("  3. Click 'Start Stream'");
console.log("  4. Graphics will be composited into the stream!\n");

console.log("💡 Tip: You can also view the graphics alone at:");
console.log(`   http://localhost:${PORT}\n`);

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

