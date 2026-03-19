#!/usr/bin/env node
/**
 * Node.js Graphics Overlay Stream
 * Generates RGBA frames using node-canvas and outputs to stdout for GStreamer appsrc
 */

const GraphicsOverlay = require("./graphicsOverlay");
const fs = require("fs");

// Read game state from JSON file
const STATE_FILE = "/tmp/graphics-overlay-state.json";

function getGameState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const data = fs.readFileSync(STATE_FILE, "utf8");
      return JSON.parse(data);
    }
  } catch (err) {
    // Ignore errors, use defaults
  }

  // Default state
  return {
    matchTitle: "Pool Match",
    player1Name: "Player 1",
    player2Name: "Player 2",
    player1Score: 0,
    player2Score: 0,
    overlayFontSize: 32,
    overlayColor: "white",
    overlayBackground: "transparent",
  };
}

// Parse command line arguments
const width = parseInt(process.argv[2]) || 1920;
const height = parseInt(process.argv[3]) || 1080;
const fps = parseInt(process.argv[4]) || 2; // Low FPS for scoreboard updates
const outputMode = process.argv[5] || "pipe"; // "pipe" or "png"
const pngPath = process.argv[6] || "/tmp/graphics-overlay.png";

// Create graphics overlay
const overlay = new GraphicsOverlay();
overlay.initialize(width, height, fps);

// Set up drawing function
overlay.setDrawFunction((ctx, frameNumber) => {
  // Get current game state
  const state = getGameState();

  // Log state every 30 frames (every 15 seconds at 2fps) for debugging
  if (frameNumber % 30 === 0) {
    console.error(`🎨 Drawing frame ${frameNumber} | Score: ${state.player1Score} - ${state.player2Score} | Font: ${state.overlayFontSize}px`);
  }

  // Clear canvas (canvas is sized to the scoreboard box, positioned by GStreamer compositor)
  ctx.clearRect(0, 0, width, height);

  // Semi-transparent background (fills entire canvas)
  ctx.fillStyle = "rgba(0, 0, 0, 0.7)";
  ctx.fillRect(0, 0, width, height);

  // Border
  ctx.strokeStyle = "white";
  ctx.lineWidth = 3;
  ctx.strokeRect(0, 0, width, height);

  // Fixed font sizes for scoreboard (independent of overlayFontSize which is for title/timestamp)
  const titleFontSize = 32;
  const scoreFontSize = 60;
  const nameFontSize = 24;

  // Get color from state
  const textColor = state.overlayColor || "white";

  // Title
  ctx.fillStyle = textColor;
  ctx.font = `bold ${titleFontSize}px Sans`;
  ctx.fillText(state.matchTitle, 20, 45);

  // Scores
  ctx.font = `bold ${scoreFontSize}px Sans`;
  ctx.fillText(`${state.player1Score} - ${state.player2Score}`, 130, 130);

  // Player names
  ctx.font = `${nameFontSize}px Sans`;
  ctx.fillStyle = textColor === "white" ? "rgba(255, 255, 255, 0.8)" : textColor;
  ctx.fillText(state.player1Name, 20, 180);
  ctx.fillText(state.player2Name, width - 120, 180);
});

// Log to stderr (stdout is used for RGBA data in pipe mode)
console.error(`🎨 Node.js Graphics Overlay Stream`);
console.error(`📐 Resolution: ${width}x${height} @ ${fps}fps`);
console.error(`📊 Output mode: ${outputMode}`);
if (outputMode === "pipe") {
  console.error(`📊 RGBA buffer size: ${width * height * 4} bytes per frame`);
} else {
  console.error(`📁 PNG output: ${pngPath}`);
}
console.error(`📁 Reading state from: ${STATE_FILE}`);
console.error(`✅ Starting frame generation...`);

// Start in specified mode
if (outputMode === "png") {
  overlay.start(outputMode, pngPath);
} else {
  overlay.start(outputMode);
}

// Handle cleanup
process.on("SIGINT", () => {
  console.error("🛑 Stopping graphics overlay...");
  overlay.stop();
  process.exit(0);
});

process.on("SIGTERM", () => {
  console.error("🛑 Stopping graphics overlay...");
  overlay.stop();
  process.exit(0);
});

