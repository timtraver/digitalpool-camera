console.log("=".repeat(60));
console.log("🎬 DIGITALPOOL CAMERA APP.JS STARTING");
console.log("=".repeat(60));

// Initialize Socket.IO connection
const socket = io();
console.log("🔌 Socket.IO initialized:", socket);

// Connection status
const statusElement = document.getElementById("connectionStatus");

socket.on("connect", () => {
  statusElement.textContent = "Connected";
  statusElement.className = "status-connected";
  console.log("Connected to server");
});

socket.on("disconnect", () => {
  statusElement.textContent = "Disconnected";
  statusElement.className = "status-disconnected";
  console.log("Disconnected from server");
});

socket.on("controlResult", (result) => {
  console.log("Control result:", result);
  if (!result.success) {
    console.error("Control error:", result.error);
  }
});

// Pan/Tilt/Zoom Controls
// Define movement speeds
const SMALL_MOVE = 0.5; // degrees for inner buttons
const LARGE_MOVE = 5.0; // degrees for outer buttons

// Inner ring - Small movements
document.getElementById("panLeftSmall").addEventListener("click", () => {
  socket.emit("pan", { degrees: SMALL_MOVE });
});

document.getElementById("panRightSmall").addEventListener("click", () => {
  socket.emit("pan", { degrees: -SMALL_MOVE });
});

document.getElementById("tiltUpSmall").addEventListener("click", () => {
  socket.emit("tilt", { degrees: SMALL_MOVE });
});

document.getElementById("tiltDownSmall").addEventListener("click", () => {
  socket.emit("tilt", { degrees: -SMALL_MOVE });
});

// Outer ring - Large movements
document.getElementById("panLeftLarge").addEventListener("click", () => {
  socket.emit("pan", { degrees: LARGE_MOVE });
});

document.getElementById("panRightLarge").addEventListener("click", () => {
  socket.emit("pan", { degrees: -LARGE_MOVE });
});

document.getElementById("tiltUpLarge").addEventListener("click", () => {
  socket.emit("tilt", { degrees: LARGE_MOVE });
});

document.getElementById("tiltDownLarge").addEventListener("click", () => {
  socket.emit("tilt", { degrees: -LARGE_MOVE });
});

// Center reset button
document.getElementById("resetPos").addEventListener("click", () => {
  socket.emit("resetPosition");
});

// Zoom controls
const zoomSlider = document.getElementById("zoomSlider");
const zoomValue = document.getElementById("zoomValue");
let currentZoom = 0;

if (zoomSlider && zoomValue) {
  zoomSlider.addEventListener("input", (e) => {
    const value = parseInt(e.target.value);
    zoomValue.textContent = value;
    currentZoom = value;
    socket.emit("zoom", { level: value });
  });
}

const zoomInBtn = document.getElementById("zoomIn");
const zoomOutBtn = document.getElementById("zoomOut");

if (zoomInBtn) {
  zoomInBtn.addEventListener("click", () => {
    if (currentZoom < 12) {
      currentZoom++;
      if (zoomSlider) zoomSlider.value = currentZoom;
      if (zoomValue) zoomValue.textContent = currentZoom;
      socket.emit("zoom", { level: currentZoom });
    }
  });
}

if (zoomOutBtn) {
  zoomOutBtn.addEventListener("click", () => {
    if (currentZoom > 0) {
      currentZoom--;
      if (zoomSlider) zoomSlider.value = currentZoom;
      if (zoomValue) zoomValue.textContent = currentZoom;
      socket.emit("zoom", { level: currentZoom });
    }
  });
}

// Helper function to create control handlers
function createSliderControl(controlName, elementId, valueDisplayId) {
  const slider = document.getElementById(elementId);
  const valueDisplay = document.getElementById(valueDisplayId);

  if (!slider || !valueDisplay) {
    console.warn(
      `⚠️ Missing elements for ${controlName}: slider=${!!slider}, display=${!!valueDisplay}`,
    );
    return;
  }

  slider.addEventListener("input", (e) => {
    const value = parseInt(e.target.value);
    valueDisplay.textContent = value;
  });

  slider.addEventListener("change", (e) => {
    const value = parseInt(e.target.value);
    socket.emit("setControl", { control: controlName, value: value });
  });
}

// Image Quality Controls
createSliderControl("brightness", "brightness", "brightnessValue");
createSliderControl("contrast", "contrast", "contrastValue");
createSliderControl("saturation", "saturation", "saturationValue");
createSliderControl("sharpness", "sharpness", "sharpnessValue");

// Exposure Controls
const exposureAuto = document.getElementById("exposureAuto");
if (exposureAuto) {
  exposureAuto.addEventListener("change", (e) => {
    const value = parseInt(e.target.value);
    socket.emit("setControl", { control: "exposure_auto", value: value });
  });
}

createSliderControl(
  "exposure_absolute",
  "exposureAbsolute",
  "exposureAbsoluteValue",
);
createSliderControl("gain", "gain", "gainValue");
createSliderControl(
  "backlight_compensation",
  "backlightCompensation",
  "backlightCompensationValue",
);

// White Balance Controls
const whiteBalanceAuto = document.getElementById("whiteBalanceAuto");
if (whiteBalanceAuto) {
  whiteBalanceAuto.addEventListener("change", (e) => {
    const value = e.target.checked ? 1 : 0;
    socket.emit("setControl", {
      control: "white_balance_temperature_auto",
      value: value,
    });
  });
}

createSliderControl(
  "white_balance_temperature",
  "whiteBalanceTemp",
  "whiteBalanceTempValue",
);

// Focus Controls
const focusAuto = document.getElementById("focusAuto");
if (focusAuto) {
  focusAuto.addEventListener("change", (e) => {
    const value = e.target.checked ? 1 : 0;
    socket.emit("setControl", { control: "focus_auto", value: value });
  });
}

createSliderControl("focus_absolute", "focusAbsolute", "focusAbsoluteValue");

// Reset all settings
const resetAllBtn = document.getElementById("resetAll");
if (resetAllBtn) {
  resetAllBtn.addEventListener("click", async () => {
    if (confirm("Reset all camera settings to defaults?")) {
      // Reset to default values
      const defaults = {
        brightness: 50,
        contrast: 50,
        saturation: 50,
        sharpness: 50,
        exposure_auto: 0,
        exposure_absolute: 330,
        gain: 1,
        backlight_compensation: 9,
        white_balance_temperature_auto: 1,
        white_balance_temperature: 5000,
        focus_auto: 1,
        focus_absolute: 0,
      };

      for (const [control, value] of Object.entries(defaults)) {
        socket.emit("setControl", { control: control, value: value });
      }

      // Reset UI
      document.getElementById("brightness").value = 50;
      document.getElementById("brightnessValue").textContent = 50;
      document.getElementById("contrast").value = 50;
      document.getElementById("contrastValue").textContent = 50;
      document.getElementById("saturation").value = 50;
      document.getElementById("saturationValue").textContent = 50;
      document.getElementById("sharpness").value = 50;
      document.getElementById("sharpnessValue").textContent = 50;

      // Reset position
      socket.emit("resetPosition");
    }
  });
}

// Keyboard controls
// Hold Shift for large movements, otherwise small movements
document.addEventListener("keydown", (e) => {
  const speed = e.shiftKey ? LARGE_MOVE : SMALL_MOVE;
  switch (e.key) {
    case "ArrowLeft":
      e.preventDefault();
      socket.emit("pan", { degrees: speed });
      break;
    case "ArrowRight":
      e.preventDefault();
      socket.emit("pan", { degrees: -speed });
      break;
    case "ArrowUp":
      e.preventDefault();
      socket.emit("tilt", { degrees: speed });
      break;
    case "ArrowDown":
      e.preventDefault();
      socket.emit("tilt", { degrees: -speed });
      break;
  }
});

// ============ STREAMING CONTROLS ============

const streamProtocol = document.getElementById("streamProtocol");
const streamDestination = document.getElementById("streamDestination");
const streamBitrate = document.getElementById("streamBitrate");
const startStreamBtn = document.getElementById("startStream");
const stopStreamBtn = document.getElementById("stopStream");
const streamStatusText = document.getElementById("streamStatusText");

// Update placeholder based on protocol
streamProtocol.addEventListener("change", () => {
  const protocol = streamProtocol.value;
  if (protocol === "srt") {
    streamDestination.placeholder = "srt://server:port";
  } else if (protocol === "rtmp") {
    streamDestination.placeholder = "rtmp://server/live/stream";
  }
});

// Start stream
startStreamBtn.addEventListener("click", async () => {
  const config = {
    protocol: streamProtocol.value,
    destination: streamDestination.value,
    bitrate: parseInt(streamBitrate.value),
    width: 1920,
    height: 1080,
    framerate: 30,
    encoder: "nvv4l2h264enc",
  };

  if (!config.destination) {
    alert("Please enter a destination URL");
    return;
  }

  console.log("Starting stream with config:", config);
  socket.emit("startStream", config);

  // Disable start, enable stop
  startStreamBtn.disabled = true;
  streamStatusText.textContent = "Starting...";
  streamStatusText.style.color = "#f59e0b";
});

// Stop stream
stopStreamBtn.addEventListener("click", () => {
  console.log("Stopping stream");
  socket.emit("stopStream");

  streamStatusText.textContent = "Stopping...";
  streamStatusText.style.color = "#f59e0b";
});

// Stream result handler
socket.on("streamResult", (result) => {
  console.log("Stream result:", result);
  if (!result.success) {
    alert(`Stream error: ${result.error}`);
    startStreamBtn.disabled = false;
    stopStreamBtn.disabled = true;
    streamStatusText.textContent = "Error";
    streamStatusText.style.color = "#ef4444";
  }
});

// Stream status updates
socket.on("streamStatus", (status) => {
  console.log("Stream status:", status);

  if (status.isStreaming) {
    startStreamBtn.disabled = true;
    stopStreamBtn.disabled = false;
    streamStatusText.textContent = `Streaming (${status.config?.protocol?.toUpperCase()})`;
    streamStatusText.style.color = "#10b981";
  } else {
    startStreamBtn.disabled = false;
    stopStreamBtn.disabled = true;
    streamStatusText.textContent = "Not streaming";
    streamStatusText.style.color = "rgba(255, 255, 255, 0.7)";
  }
});

// Stream error handler
socket.on("streamError", (data) => {
  console.error("Stream error:", data.error);
  streamStatusText.textContent = "Stream error";
  streamStatusText.style.color = "#ef4444";
});

// Get initial stream status on connect
socket.on("connect", () => {
  socket.emit("getStreamStatus");
});

// ============ OVERLAY CONTROLS ============

const overlayEnabled = document.getElementById("overlayEnabled");
const overlayText = document.getElementById("overlayText");
const customText2 = document.getElementById("customText2");
const showTimestamp = document.getElementById("showTimestamp");
const overlayPosition = document.getElementById("overlayPosition");
const overlayFontSize = document.getElementById("overlayFontSize");
const fontSizeValue = document.getElementById("fontSizeValue");
const overlayColor = document.getElementById("overlayColor");
const overlayBackground = document.getElementById("overlayBackground");
const overlayBackgroundOpacity = document.getElementById(
  "overlayBackgroundOpacity",
);
const backgroundOpacityValue = document.getElementById(
  "backgroundOpacityValue",
);
const applyOverlayBtn = document.getElementById("applyOverlay");

console.log("🚀 app.js loaded!");

// Canvas overlay for preview
const videoStream = document.getElementById("videoStream");
const overlayCanvas = document.getElementById("overlayCanvas");
const ctx = overlayCanvas.getContext("2d");

console.log("📺 Video element:", videoStream);
console.log("🎨 Canvas element:", overlayCanvas);
console.log("🖌️ Canvas context:", ctx);

// Debug elements
const canvasSizeSpan = document.getElementById("canvasSize");
const resizeCanvasBtn = document.getElementById("resizeCanvas");

console.log("🔧 Debug elements:", {
  canvasSizeSpan,
  resizeCanvasBtn,
});

// Current overlay config
let currentOverlayConfig = {
  overlayEnabled: false,
  overlayText: "",
  customText2: "",
  showTimestamp: false,
  overlayPosition: "top-left",
  overlayFontSize: 32,
  overlayColor: "white",
  overlayBackground: "transparent",
  overlayBackgroundOpacity: 70,
};

// Update canvas size when video loads or changes
function updateCanvasSize() {
  const rect = videoStream.getBoundingClientRect();

  console.log("updateCanvasSize called - rect:", rect.width, "x", rect.height);

  // Only update if we have valid dimensions
  if (rect.width > 0 && rect.height > 0) {
    // Don't use DPR scaling - just match display size exactly
    // This gives us crystal clear rendering like the test button did
    overlayCanvas.width = rect.width;
    overlayCanvas.height = rect.height;

    console.log("✅ Canvas sized:", rect.width, "x", rect.height);

    // Update debug info
    if (canvasSizeSpan) {
      canvasSizeSpan.textContent = `${rect.width}x${rect.height}`;
    }

    return true; // Success
  } else {
    console.warn("⚠️ Video has no dimensions yet, retrying...");
    if (canvasSizeSpan) {
      canvasSizeSpan.textContent = "Waiting for video...";
    }

    return false; // Failed
  }
}

// MJPEG streams don't fire 'load' events, so we need to poll
let canvasInitialized = false;
let initAttempts = 0;
const MAX_INIT_ATTEMPTS = 50; // Try for 10 seconds

function initializeCanvas() {
  initAttempts++;
  console.log(`🔄 Canvas init attempt ${initAttempts}/${MAX_INIT_ATTEMPTS}`);

  const success = updateCanvasSize();

  if (success && !canvasInitialized) {
    canvasInitialized = true;
    console.log("✅ Canvas initialized successfully!");
    drawOverlay();
  } else if (!canvasInitialized && initAttempts < MAX_INIT_ATTEMPTS) {
    // Keep trying with increasing delays
    const delay = initAttempts < 10 ? 200 : 500;
    setTimeout(initializeCanvas, delay);
  } else if (initAttempts >= MAX_INIT_ATTEMPTS) {
    console.error(
      "❌ Failed to initialize canvas after",
      MAX_INIT_ATTEMPTS,
      "attempts",
    );
    console.error("Video element might not be loading. Check MJPEG stream.");
  }
}

// Start initialization immediately
initializeCanvas();

// Also try again after 2 seconds (in case video loads slowly)
setTimeout(() => {
  if (!canvasInitialized) {
    console.log("🔄 Retrying canvas initialization after 2s delay...");
    initAttempts = 0; // Reset counter
    initializeCanvas();
  }
}, 2000);

// Try again after 5 seconds (MJPEG streams can be slow to start)
setTimeout(() => {
  if (!canvasInitialized) {
    console.log("🔄 Retrying canvas initialization after 5s delay...");
    initAttempts = 0; // Reset counter
    initializeCanvas();
  }
}, 5000);

// Also update on window resize
window.addEventListener("resize", () => {
  updateCanvasSize();
  drawOverlay();
});

// Manual resize button
if (resizeCanvasBtn) {
  resizeCanvasBtn.addEventListener("click", () => {
    console.log("🔄 Manual canvas resize triggered");
    const rect = videoStream.getBoundingClientRect();
    console.log("Video element rect:", rect);
    console.log(
      "Video natural size:",
      videoStream.naturalWidth,
      "x",
      videoStream.naturalHeight,
    );
    console.log(
      "Video client size:",
      videoStream.clientWidth,
      "x",
      videoStream.clientHeight,
    );

    updateCanvasSize();
    drawOverlay();
  });
}

// Redraw overlay every 100ms (for timestamp updates)
setInterval(() => {
  if (currentOverlayConfig.overlayEnabled) {
    drawOverlay();
  } else {
    ctx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
  }
}, 100);

// Draw overlay on canvas
function drawOverlay() {
  console.log("=== drawOverlay called ===");
  console.log(
    "Canvas dimensions:",
    overlayCanvas.width,
    "x",
    overlayCanvas.height,
  );
  console.log("Overlay config:", currentOverlayConfig);

  // Clear canvas
  ctx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);

  if (!currentOverlayConfig.overlayEnabled) {
    console.log("Overlay disabled, clearing canvas");
    return;
  }

  // Check if canvas has valid dimensions
  if (overlayCanvas.width === 0 || overlayCanvas.height === 0) {
    console.warn("Canvas has no dimensions, skipping draw");
    return;
  }

  // Scale font size based on canvas width (assuming 1920px base)
  const scale = overlayCanvas.width / 1920 || 1;
  const fontSize = Math.floor(currentOverlayConfig.overlayFontSize * scale);
  const smallFontSize = Math.floor(fontSize * 0.75);
  const padding = 20 * scale;

  console.log("Scale:", scale, "fontSize:", fontSize, "padding:", padding);

  // Get background color with opacity
  function getBackgroundColor() {
    const opacity = currentOverlayConfig.overlayBackgroundOpacity / 100;

    switch (currentOverlayConfig.overlayBackground) {
      case "transparent":
        return "rgba(0, 0, 0, 0)";
      case "semi-black":
        return `rgba(0, 0, 0, ${opacity})`;
      case "semi-white":
        return `rgba(255, 255, 255, ${opacity})`;
      case "black":
        return "rgba(0, 0, 0, 1)";
      case "white":
        return "rgba(255, 255, 255, 1)";
      default:
        return `rgba(0, 0, 0, ${opacity})`;
    }
  }

  // Determine position and alignment
  let xPos, yPos, textAlign, textBaseline;
  const position = currentOverlayConfig.overlayPosition;

  if (position.includes("top")) {
    yPos = padding;
    textBaseline = "top";
  } else if (position.includes("bottom")) {
    yPos = overlayCanvas.height - padding;
    textBaseline = "bottom";
  } else {
    yPos = overlayCanvas.height / 2;
    textBaseline = "middle";
  }

  if (position.includes("left")) {
    xPos = padding;
    textAlign = "left";
  } else if (position.includes("right")) {
    xPos = overlayCanvas.width - padding;
    textAlign = "right";
  } else {
    xPos = overlayCanvas.width / 2;
    textAlign = "center";
  }

  ctx.textAlign = textAlign;
  ctx.textBaseline = textBaseline;

  const bgColor = getBackgroundColor();
  let currentY = yPos;

  // Helper function to draw text with background
  function drawTextWithBackground(text, font, yOffset = 0) {
    ctx.font = font;
    const metrics = ctx.measureText(text);
    const textWidth = metrics.width;
    const textHeight = fontSize; // Approximate height

    const actualY = currentY + yOffset;

    // Calculate background rectangle based on alignment
    let bgX, bgY, bgWidth, bgHeight;

    if (textAlign === "left") {
      bgX = xPos - padding / 2;
      bgWidth = textWidth + padding;
    } else if (textAlign === "right") {
      bgX = xPos - textWidth - padding / 2;
      bgWidth = textWidth + padding;
    } else {
      bgX = xPos - textWidth / 2 - padding / 2;
      bgWidth = textWidth + padding;
    }

    if (textBaseline === "top") {
      bgY = actualY - padding / 4;
      bgHeight = textHeight + padding / 2;
    } else if (textBaseline === "bottom") {
      bgY = actualY - textHeight - padding / 4;
      bgHeight = textHeight + padding / 2;
    } else {
      bgY = actualY - textHeight / 2 - padding / 4;
      bgHeight = textHeight + padding / 2;
    }

    // Draw background if not transparent
    if (bgColor !== "rgba(0, 0, 0, 0)") {
      ctx.fillStyle = bgColor;
      ctx.fillRect(bgX, bgY, bgWidth, bgHeight);
    }

    // Draw text
    ctx.fillStyle = currentOverlayConfig.overlayColor;
    ctx.fillText(text, xPos, actualY);

    return bgHeight;
  }

  // Draw timestamp if enabled
  if (currentOverlayConfig.showTimestamp) {
    const now = new Date();
    const timestamp = now.toLocaleString();
    console.log("Drawing timestamp:", timestamp, "at", currentY);
    const height = drawTextWithBackground(
      timestamp,
      `bold ${smallFontSize}px Sans-serif`,
      0,
    );
    currentY += height + padding / 2;
  }

  // Draw main text
  if (currentOverlayConfig.overlayText) {
    console.log(
      "Drawing main text:",
      currentOverlayConfig.overlayText,
      "at",
      currentY,
      "fontSize:",
      fontSize,
    );
    const height = drawTextWithBackground(
      currentOverlayConfig.overlayText,
      `bold ${fontSize}px Sans-serif`,
      currentOverlayConfig.showTimestamp ? 0 : 0,
    );
    currentY += height + padding / 2;
  }

  // Draw subtitle
  if (currentOverlayConfig.customText2) {
    console.log(
      "Drawing subtitle:",
      currentOverlayConfig.customText2,
      "at",
      currentY,
    );
    drawTextWithBackground(
      currentOverlayConfig.customText2,
      `${smallFontSize}px Sans-serif`,
      0,
    );
  }

  console.log("✅ Overlay drawing complete");
}

// Live preview updates (update preview as user types/changes)
overlayEnabled.addEventListener("change", () => {
  currentOverlayConfig.overlayEnabled = overlayEnabled.checked;
  console.log("Overlay enabled changed:", overlayEnabled.checked);
  drawOverlay(); // Always redraw when enabled/disabled changes
});

overlayText.addEventListener("input", () => {
  currentOverlayConfig.overlayText = overlayText.value;
  console.log("Overlay text changed:", overlayText.value);
  drawOverlay(); // Always redraw to show live preview
});

customText2.addEventListener("input", () => {
  currentOverlayConfig.customText2 = customText2.value;
  drawOverlay(); // Always redraw to show live preview
});

showTimestamp.addEventListener("change", () => {
  currentOverlayConfig.showTimestamp = showTimestamp.checked;
  drawOverlay(); // Always redraw to show live preview
});

overlayPosition.addEventListener("change", () => {
  currentOverlayConfig.overlayPosition = overlayPosition.value;
  drawOverlay(); // Always redraw to show live preview
});

overlayFontSize.addEventListener("input", () => {
  fontSizeValue.textContent = overlayFontSize.value;
  currentOverlayConfig.overlayFontSize = parseInt(overlayFontSize.value);
  drawOverlay(); // Always redraw to show live preview
});

overlayColor.addEventListener("change", () => {
  currentOverlayConfig.overlayColor = overlayColor.value;
  drawOverlay(); // Always redraw to show live preview
});

overlayBackground.addEventListener("change", () => {
  currentOverlayConfig.overlayBackground = overlayBackground.value;
  drawOverlay(); // Always redraw to show live preview
});

overlayBackgroundOpacity.addEventListener("input", () => {
  backgroundOpacityValue.textContent = overlayBackgroundOpacity.value;
  currentOverlayConfig.overlayBackgroundOpacity = parseInt(
    overlayBackgroundOpacity.value,
  );
  drawOverlay(); // Always redraw to show live preview
});

// Apply overlay settings
applyOverlayBtn.addEventListener("click", () => {
  const overlayConfig = {
    overlayEnabled: overlayEnabled.checked,
    overlayText: overlayText.value,
    customText2: customText2.value,
    showTimestamp: showTimestamp.checked,
    overlayPosition: overlayPosition.value,
    overlayFontSize: parseInt(overlayFontSize.value),
    overlayColor: overlayColor.value,
    overlayBackground: overlayBackground.value,
    overlayBackgroundOpacity: parseInt(overlayBackgroundOpacity.value),
  };

  // Update local preview immediately
  currentOverlayConfig = { ...overlayConfig };
  drawOverlay();

  console.log("Applying overlay config:", overlayConfig);
  socket.emit("updateOverlay", overlayConfig);
});

// Overlay result handler
socket.on("overlayResult", (result) => {
  console.log("Overlay result:", result);
  if (result.success) {
    alert(
      result.message || "Overlay settings updated. Restart stream to apply.",
    );
  } else {
    alert(`Overlay error: ${result.error}`);
  }
});

// Load overlay settings from stream status
socket.on("streamStatus", (status) => {
  if (status.config) {
    overlayEnabled.checked = status.config.overlayEnabled || false;
    overlayText.value = status.config.overlayText || "";
    customText2.value = status.config.customText2 || "";
    showTimestamp.checked = status.config.showTimestamp || false;
    overlayPosition.value = status.config.overlayPosition || "top";
    overlayFontSize.value = status.config.overlayFontSize || 32;
    fontSizeValue.textContent = overlayFontSize.value;
    overlayColor.value = status.config.overlayColor || "white";

    // Update preview overlay
    currentOverlayConfig = {
      overlayEnabled: status.config.overlayEnabled || false,
      overlayText: status.config.overlayText || "",
      customText2: status.config.customText2 || "",
      showTimestamp: status.config.showTimestamp || false,
      overlayPosition: status.config.overlayPosition || "top",
      overlayFontSize: status.config.overlayFontSize || 32,
      overlayColor: status.config.overlayColor || "white",
    };
    drawOverlay();
  }
});
