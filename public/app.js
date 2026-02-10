// Initialize Socket.IO connection
const socket = io();

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

zoomSlider.addEventListener("input", (e) => {
  const value = parseInt(e.target.value);
  zoomValue.textContent = value;
  currentZoom = value;
  socket.emit("zoom", { level: value });
});

document.getElementById("zoomIn").addEventListener("click", () => {
  if (currentZoom < 12) {
    currentZoom++;
    zoomSlider.value = currentZoom;
    zoomValue.textContent = currentZoom;
    socket.emit("zoom", { level: currentZoom });
  }
});

document.getElementById("zoomOut").addEventListener("click", () => {
  if (currentZoom > 0) {
    currentZoom--;
    zoomSlider.value = currentZoom;
    zoomValue.textContent = currentZoom;
    socket.emit("zoom", { level: currentZoom });
  }
});

// Helper function to create control handlers
function createSliderControl(controlName, elementId, valueDisplayId) {
  const slider = document.getElementById(elementId);
  const valueDisplay = document.getElementById(valueDisplayId);

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
document.getElementById("exposureAuto").addEventListener("change", (e) => {
  const value = parseInt(e.target.value);
  socket.emit("setControl", { control: "exposure_auto", value: value });
});

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
document.getElementById("whiteBalanceAuto").addEventListener("change", (e) => {
  const value = e.target.checked ? 1 : 0;
  socket.emit("setControl", {
    control: "white_balance_temperature_auto",
    value: value,
  });
});

createSliderControl(
  "white_balance_temperature",
  "whiteBalanceTemp",
  "whiteBalanceTempValue",
);

// Focus Controls
document.getElementById("focusAuto").addEventListener("change", (e) => {
  const value = e.target.checked ? 1 : 0;
  socket.emit("setControl", { control: "focus_auto", value: value });
});

createSliderControl("focus_absolute", "focusAbsolute", "focusAbsoluteValue");

// Reset all settings
document.getElementById("resetAll").addEventListener("click", async () => {
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
const applyOverlayBtn = document.getElementById("applyOverlay");

// Canvas overlay for preview
const videoStream = document.getElementById("videoStream");
const overlayCanvas = document.getElementById("overlayCanvas");
const ctx = overlayCanvas.getContext("2d");

// Current overlay config
let currentOverlayConfig = {
  overlayEnabled: false,
  overlayText: "",
  customText2: "",
  showTimestamp: false,
  overlayPosition: "top",
  overlayFontSize: 32,
  overlayColor: "white",
};

// Update canvas size when video loads
videoStream.addEventListener("load", () => {
  overlayCanvas.width = videoStream.naturalWidth || videoStream.width;
  overlayCanvas.height = videoStream.naturalHeight || videoStream.height;
});

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
  // Clear canvas
  ctx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);

  if (!currentOverlayConfig.overlayEnabled) return;

  // Scale font size based on canvas width (assuming 1920px base)
  const scale = overlayCanvas.width / 1920 || 1;
  const fontSize = Math.floor(currentOverlayConfig.overlayFontSize * scale);
  const smallFontSize = Math.floor(fontSize * 0.75);

  // Set text properties
  ctx.fillStyle = currentOverlayConfig.overlayColor;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";

  let yPos = 20 * scale;

  // Position based on setting
  if (currentOverlayConfig.overlayPosition === "bottom") {
    yPos = overlayCanvas.height - 80 * scale;
    ctx.textBaseline = "bottom";
  } else if (currentOverlayConfig.overlayPosition === "center") {
    yPos = overlayCanvas.height / 2 - 40 * scale;
    ctx.textBaseline = "middle";
  }

  // Draw timestamp if enabled
  if (currentOverlayConfig.showTimestamp) {
    const now = new Date();
    const timestamp = now.toLocaleString();
    ctx.font = `bold ${smallFontSize}px Sans-serif`;
    ctx.textAlign = "right";

    // Background
    const timestampWidth = ctx.measureText(timestamp).width;
    ctx.fillStyle = "rgba(0, 0, 0, 0.6)";
    ctx.fillRect(
      overlayCanvas.width - timestampWidth - 30 * scale,
      10 * scale,
      timestampWidth + 20 * scale,
      smallFontSize + 10 * scale,
    );

    // Text
    ctx.fillStyle = currentOverlayConfig.overlayColor;
    ctx.fillText(timestamp, overlayCanvas.width - 20 * scale, 15 * scale);
    ctx.textAlign = "center";
  }

  // Draw main text
  if (currentOverlayConfig.overlayText) {
    ctx.font = `bold ${fontSize}px Sans-serif`;

    // Background
    const textWidth = ctx.measureText(currentOverlayConfig.overlayText).width;
    ctx.fillStyle = "rgba(0, 0, 0, 0.6)";
    ctx.fillRect(
      overlayCanvas.width / 2 - textWidth / 2 - 20 * scale,
      yPos - 10 * scale,
      textWidth + 40 * scale,
      fontSize + 20 * scale,
    );

    // Text
    ctx.fillStyle = currentOverlayConfig.overlayColor;
    ctx.fillText(
      currentOverlayConfig.overlayText,
      overlayCanvas.width / 2,
      yPos,
    );
  }

  // Draw subtitle
  if (currentOverlayConfig.customText2) {
    const subtitleYPos = yPos + fontSize + 10 * scale;
    ctx.font = `${smallFontSize}px Sans-serif`;

    // Background
    const textWidth = ctx.measureText(currentOverlayConfig.customText2).width;
    ctx.fillStyle = "rgba(0, 0, 0, 0.6)";
    ctx.fillRect(
      overlayCanvas.width / 2 - textWidth / 2 - 15 * scale,
      subtitleYPos - 5 * scale,
      textWidth + 30 * scale,
      smallFontSize + 10 * scale,
    );

    // Text
    ctx.fillStyle = currentOverlayConfig.overlayColor;
    ctx.fillText(
      currentOverlayConfig.customText2,
      overlayCanvas.width / 2,
      subtitleYPos,
    );
  }
}

// Update font size display
overlayFontSize.addEventListener("input", () => {
  fontSizeValue.textContent = overlayFontSize.value;
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
    overlayBackground: true,
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
