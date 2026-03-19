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

  // Clear entire canvas (transparent)
  ctx.clearRect(0, 0, width, height);

  // Draw scoreboard box with margin inside the canvas
  // This ensures borders and text never touch the canvas edge
  const margin = 4;
  const boxX = margin;
  const boxY = margin;
  const boxW = width - margin * 2;
  const boxH = height - margin * 2;

  // Semi-transparent background
  ctx.fillStyle = "rgba(0, 0, 0, 0.7)";
  ctx.fillRect(boxX, boxY, boxW, boxH);

  // Border
  ctx.strokeStyle = "white";
  ctx.lineWidth = 3;
  ctx.strokeRect(boxX + 1.5, boxY + 1.5, boxW - 3, boxH - 3);

  // Fixed font sizes for scoreboard
  const titleFontSize = 32;
  const scoreFontSize = 60;
  const nameFontSize = 24;
  const padding = 20;

  // Inner content area
  const contentLeft = boxX + padding;
  const contentRight = boxX + boxW - padding;
  const contentWidth = boxW - padding * 2;

  // Get color from state
  const textColor = state.overlayColor || "white";

  // Title
  ctx.fillStyle = textColor;
  ctx.font = `bold ${titleFontSize}px Sans`;
  ctx.fillText(state.matchTitle, contentLeft, boxY + 42);

  // Scores - centered in box
  ctx.font = `bold ${scoreFontSize}px Sans`;
  const scoreText = `${state.player1Score} - ${state.player2Score}`;
  const scoreWidth = ctx.measureText(scoreText).width;
  ctx.fillText(scoreText, boxX + (boxW - scoreWidth) / 2, boxY + 120);

  // Player names
  ctx.font = `${nameFontSize}px Sans`;
  ctx.fillStyle = textColor === "white" ? "rgba(255, 255, 255, 0.8)" : textColor;

  // Truncate names if they would overlap (each name gets half the content width)
  const maxNameWidth = contentWidth / 2 - 10; // 10px gap between names

  // Player 1 - left aligned
  let p1Name = state.player1Name;
  while (ctx.measureText(p1Name).width > maxNameWidth && p1Name.length > 1) {
    p1Name = p1Name.slice(0, -1);
  }
  ctx.fillText(p1Name, contentLeft, boxY + boxH - padding);

  // Player 2 - right aligned
  let p2Name = state.player2Name;
  while (ctx.measureText(p2Name).width > maxNameWidth && p2Name.length > 1) {
    p2Name = p2Name.slice(0, -1);
  }
  const p2Width = ctx.measureText(p2Name).width;
  ctx.fillText(p2Name, contentRight - p2Width, boxY + boxH - padding);
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

