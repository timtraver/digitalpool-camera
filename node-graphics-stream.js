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
  };
}

// Parse command line arguments
const width = parseInt(process.argv[2]) || 1920;
const height = parseInt(process.argv[3]) || 1080;
const fps = parseInt(process.argv[4]) || 30;

// Create graphics overlay
const overlay = new GraphicsOverlay();
overlay.initialize(width, height, fps);

// Set up drawing function
overlay.setDrawFunction((ctx, frameNumber) => {
  // Get current game state
  const state = getGameState();

  // Clear canvas with transparent background
  ctx.clearRect(0, 0, width, height);

  // Draw a pool scoreboard in the top-left corner
  const x = 50;
  const y = 50;
  const boxWidth = 500;
  const boxHeight = 200;

  // Semi-transparent background
  ctx.fillStyle = "rgba(0, 0, 0, 0.7)";
  ctx.fillRect(x, y, boxWidth, boxHeight);

  // Border
  ctx.strokeStyle = "white";
  ctx.lineWidth = 3;
  ctx.strokeRect(x, y, boxWidth, boxHeight);

  // Title
  ctx.fillStyle = "white";
  ctx.font = "bold 32px Sans";
  ctx.fillText(state.matchTitle, x + 20, y + 45);

  // Scores
  ctx.font = "bold 60px Sans";
  ctx.fillText(`${state.player1Score} - ${state.player2Score}`, x + 180, y + 130);

  // Player names
  ctx.font = "24px Sans";
  ctx.fillStyle = "rgba(255, 255, 255, 0.8)";
  ctx.fillText(state.player1Name, x + 20, y + 180);
  ctx.fillText(state.player2Name, x + boxWidth - 120, y + 180);
});

// Log to stderr (stdout is used for RGBA data)
console.error(`🎨 Node.js Graphics Overlay Stream`);
console.error(`📐 Resolution: ${width}x${height} @ ${fps}fps`);
console.error(`📊 RGBA buffer size: ${width * height * 4} bytes per frame`);
console.error(`📁 Reading state from: ${STATE_FILE}`);
console.error(`✅ Starting frame generation...`);

// Start in pipe mode
overlay.start("pipe");

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

