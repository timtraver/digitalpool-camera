console.log("=".repeat(60));
console.log("🎬 DIGITALPOOL CAMERA APP.JS STARTING");
console.log("=".repeat(60));

// Custom Dropdown Helper Function
function createCustomDropdown(selectElement) {
  const options = Array.from(selectElement.options).map((opt) => ({
    value: opt.value,
    text: opt.text,
    selected: opt.selected,
  }));

  const selectedOption = options.find((opt) => opt.selected) || options[0];

  // Create custom dropdown structure
  const container = document.createElement("div");
  container.className = "custom-dropdown";

  const selected = document.createElement("div");
  selected.className = "custom-dropdown-selected";
  selected.textContent = selectedOption.text;
  selected.dataset.value = selectedOption.value;

  const optionsContainer = document.createElement("div");
  optionsContainer.className = "custom-dropdown-options";

  options.forEach((opt) => {
    const optionDiv = document.createElement("div");
    optionDiv.className = "custom-dropdown-option";
    if (opt.value === selectedOption.value) {
      optionDiv.classList.add("selected");
    }
    optionDiv.textContent = opt.text;
    optionDiv.dataset.value = opt.value;

    optionDiv.addEventListener("click", () => {
      // Update selected display
      selected.textContent = opt.text;
      selected.dataset.value = opt.value;

      // Update selected class
      optionsContainer
        .querySelectorAll(".custom-dropdown-option")
        .forEach((o) => {
          o.classList.remove("selected");
        });
      optionDiv.classList.add("selected");

      // Update original select element
      selectElement.value = opt.value;

      // Trigger change event on original select
      const event = new Event("change", { bubbles: true });
      selectElement.dispatchEvent(event);

      // Close dropdown
      optionsContainer.classList.remove("open");
      selected.classList.remove("open");
    });

    optionsContainer.appendChild(optionDiv);
  });

  // Toggle dropdown
  selected.addEventListener("click", (e) => {
    e.stopPropagation();
    const isOpen = optionsContainer.classList.contains("open");

    // Close all other dropdowns
    document
      .querySelectorAll(".custom-dropdown-options.open")
      .forEach((dropdown) => {
        dropdown.classList.remove("open");
      });
    document
      .querySelectorAll(".custom-dropdown-selected.open")
      .forEach((sel) => {
        sel.classList.remove("open");
      });

    // Toggle this dropdown
    if (!isOpen) {
      optionsContainer.classList.add("open");
      selected.classList.add("open");
    }
  });

  container.appendChild(selected);
  container.appendChild(optionsContainer);

  // Hide original select
  selectElement.style.display = "none";

  // Insert custom dropdown after original select
  selectElement.parentNode.insertBefore(container, selectElement.nextSibling);

  return container;
}

// Close dropdowns when clicking outside
document.addEventListener("click", () => {
  document
    .querySelectorAll(".custom-dropdown-options.open")
    .forEach((dropdown) => {
      dropdown.classList.remove("open");
    });
  document.querySelectorAll(".custom-dropdown-selected.open").forEach((sel) => {
    sel.classList.remove("open");
  });
});

// Initialize Socket.IO connection
const socket = io();
console.log("🔌 Socket.IO initialized:", socket);

// Connection status
const statusElement = document.getElementById("connectionStatus");

socket.on("connect", () => {
  statusElement.textContent = "Camera Connected";
  statusElement.className = "status status-connected";
  console.log("Connected to server");
});

socket.on("disconnect", () => {
  statusElement.textContent = "Camera Disconnected";
  statusElement.className = "status status-disconnected";
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
const overlayType = document.getElementById("overlayType");
const textOverlayOptions = document.getElementById("textOverlayOptions");
const urlOverlayOptions = document.getElementById("urlOverlayOptions");
const overlayText = document.getElementById("overlayText");
const customText2 = document.getElementById("customText2");
const showTimestamp = document.getElementById("showTimestamp");
const overlayUrl = document.getElementById("overlayUrl");
const timestampPosition = document.getElementById("timestampPosition");
const titlePosition = document.getElementById("titlePosition");
const subtitlePosition = document.getElementById("subtitlePosition");
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
const testOverlayBtn = document.getElementById("testOverlay");

// Initialize custom dropdowns for position selects
console.log("🎨 Initializing custom dropdowns...");
createCustomDropdown(timestampPosition);
createCustomDropdown(titlePosition);
createCustomDropdown(subtitlePosition);
createCustomDropdown(overlayType);
createCustomDropdown(overlayBackground);
console.log("✅ Custom dropdowns initialized");

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
  overlayType: "text",
  overlayText: "",
  customText2: "",
  showTimestamp: false,
  overlayUrl: "",
  timestampPosition: "bottom-right",
  titlePosition: "top-left",
  subtitlePosition: "top-left",
  overlayFontSize: 32,
  overlayColor: "white",
  overlayBackground: "transparent",
  overlayBackgroundOpacity: 70,
};

// URL overlay iframe
let urlOverlayIframe = null;

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

// Toggle overlay type options
overlayType.addEventListener("change", () => {
  const type = overlayType.value;
  currentOverlayConfig.overlayType = type;

  if (type === "text") {
    textOverlayOptions.style.display = "block";
    urlOverlayOptions.style.display = "none";
  } else if (type === "url") {
    textOverlayOptions.style.display = "none";
    urlOverlayOptions.style.display = "block";
  }

  drawOverlay();
});

// Redraw overlay every 100ms (for timestamp updates and URL overlay)
setInterval(() => {
  if (currentOverlayConfig.overlayEnabled) {
    drawOverlay();
  } else {
    ctx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
    // Hide URL overlay iframe if exists
    if (urlOverlayIframe) {
      urlOverlayIframe.style.display = "none";
    }
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
    // Hide URL overlay iframe if exists
    if (urlOverlayIframe) {
      urlOverlayIframe.style.display = "none";
    }
    return;
  }

  // Check if canvas has valid dimensions
  if (overlayCanvas.width === 0 || overlayCanvas.height === 0) {
    console.warn("Canvas has no dimensions, skipping draw");
    return;
  }

  // Handle URL overlay
  if (currentOverlayConfig.overlayType === "url") {
    drawUrlOverlay();
    return;
  }

  // Handle text overlay (existing code)
  drawTextOverlay();
}

// Draw URL overlay using iframe
function drawUrlOverlay() {
  if (!currentOverlayConfig.overlayUrl) {
    console.log("No URL specified for overlay");
    if (urlOverlayIframe) {
      urlOverlayIframe.style.display = "none";
    }
    return;
  }

  // Create iframe if it doesn't exist
  if (!urlOverlayIframe) {
    urlOverlayIframe = document.createElement("iframe");
    urlOverlayIframe.id = "urlOverlayIframe";
    urlOverlayIframe.style.position = "absolute";
    urlOverlayIframe.style.top = "0";
    urlOverlayIframe.style.left = "0";
    urlOverlayIframe.style.width = "100%";
    urlOverlayIframe.style.height = "100%";
    urlOverlayIframe.style.border = "none";
    urlOverlayIframe.style.pointerEvents = "none"; // Don't capture mouse events
    urlOverlayIframe.style.zIndex = "10"; // Above canvas
    overlayCanvas.parentElement.appendChild(urlOverlayIframe);
  }

  // Update iframe src if changed
  if (urlOverlayIframe.src !== currentOverlayConfig.overlayUrl) {
    console.log("Loading URL overlay:", currentOverlayConfig.overlayUrl);
    urlOverlayIframe.src = currentOverlayConfig.overlayUrl;
  }

  urlOverlayIframe.style.display = "block";
}

// Draw text overlay on canvas
function drawTextOverlay() {
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

  const bgColor = getBackgroundColor();

  // Helper function to calculate position from position string
  function getPositionCoords(position) {
    let xPos, yPos, textAlign, textBaseline;

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

    return { xPos, yPos, textAlign, textBaseline };
  }

  // Helper function to draw single text element
  function drawSingleText(text, font, position) {
    const { xPos, yPos, textAlign, textBaseline } = getPositionCoords(position);

    ctx.textAlign = textAlign;
    ctx.textBaseline = textBaseline;
    ctx.font = font;

    const metrics = ctx.measureText(text);
    const textWidth = metrics.width;
    const textHeight = fontSize;

    // Calculate background rectangle
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
      bgY = yPos - padding / 4;
      bgHeight = textHeight + padding / 2;
    } else if (textBaseline === "bottom") {
      bgY = yPos - textHeight - padding / 4;
      bgHeight = textHeight + padding / 2;
    } else {
      bgY = yPos - textHeight / 2 - padding / 4;
      bgHeight = textHeight + padding / 2;
    }

    // Draw background if not transparent
    if (bgColor !== "rgba(0, 0, 0, 0)") {
      ctx.fillStyle = bgColor;
      ctx.fillRect(bgX, bgY, bgWidth, bgHeight);
    }

    // Draw text
    ctx.fillStyle = currentOverlayConfig.overlayColor;
    ctx.fillText(text, xPos, yPos);

    console.log(
      `Drew text "${text}" at position ${position} (${xPos}, ${yPos})`,
    );
  }

  // Draw timestamp if enabled
  if (currentOverlayConfig.showTimestamp) {
    const now = new Date();
    const timestamp = now.toLocaleString();
    drawSingleText(
      timestamp,
      `bold ${smallFontSize}px Sans-serif`,
      currentOverlayConfig.timestampPosition,
    );
  }

  // Draw main text (title)
  if (currentOverlayConfig.overlayText) {
    drawSingleText(
      currentOverlayConfig.overlayText,
      `bold ${fontSize}px Sans-serif`,
      currentOverlayConfig.titlePosition,
    );
  }

  // Draw subtitle
  if (currentOverlayConfig.customText2) {
    drawSingleText(
      currentOverlayConfig.customText2,
      `${smallFontSize}px Sans-serif`,
      currentOverlayConfig.subtitlePosition,
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

// URL overlay input
overlayUrl.addEventListener("input", () => {
  currentOverlayConfig.overlayUrl = overlayUrl.value;
  drawOverlay(); // Always redraw to show live preview
});

// Position dropdowns
timestampPosition.addEventListener("change", () => {
  currentOverlayConfig.timestampPosition = timestampPosition.value;
  drawOverlay();
});

titlePosition.addEventListener("change", () => {
  currentOverlayConfig.titlePosition = titlePosition.value;
  drawOverlay();
});

subtitlePosition.addEventListener("change", () => {
  currentOverlayConfig.subtitlePosition = subtitlePosition.value;
  drawOverlay();
});

// Test overlay button - for debugging
testOverlayBtn.addEventListener("click", () => {
  console.log("🧪 TEST OVERLAY BUTTON CLICKED");
  console.log("Current overlay config:", currentOverlayConfig);
  console.log(
    "Canvas dimensions:",
    overlayCanvas.width,
    "x",
    overlayCanvas.height,
  );
  console.log("Overlay enabled checkbox:", overlayEnabled.checked);
  console.log("Overlay text input:", overlayText.value);
  console.log("Custom text 2 input:", customText2.value);

  // Force enable and set test values
  currentOverlayConfig.overlayEnabled = true;
  currentOverlayConfig.overlayType = "text";
  currentOverlayConfig.overlayText = "TEST TITLE";
  currentOverlayConfig.customText2 = "TEST SUBTITLE";
  currentOverlayConfig.showTimestamp = true;
  currentOverlayConfig.timestampPosition = "bottom-right";
  currentOverlayConfig.titlePosition = "top-left";
  currentOverlayConfig.subtitlePosition = "top-left";
  currentOverlayConfig.overlayColor = "white";
  currentOverlayConfig.overlayFontSize = 32;

  console.log("Updated config for test:", currentOverlayConfig);
  drawOverlay();

  alert("Test overlay drawn! Check console for details.");
});

// Apply overlay settings
applyOverlayBtn.addEventListener("click", () => {
  const overlayConfig = {
    overlayEnabled: overlayEnabled.checked,
    overlayType: overlayType.value,
    overlayText: overlayText.value,
    customText2: customText2.value,
    showTimestamp: showTimestamp.checked,
    overlayUrl: overlayUrl.value,
    timestampPosition: timestampPosition.value,
    titlePosition: titlePosition.value,
    subtitlePosition: subtitlePosition.value,
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
    overlayType.value = status.config.overlayType || "text";
    overlayText.value = status.config.overlayText || "";
    customText2.value = status.config.customText2 || "";
    showTimestamp.checked = status.config.showTimestamp || false;
    overlayUrl.value = status.config.overlayUrl || "";
    timestampPosition.value = status.config.timestampPosition || "bottom-right";
    titlePosition.value = status.config.titlePosition || "top-left";
    subtitlePosition.value = status.config.subtitlePosition || "top-left";
    overlayFontSize.value = status.config.overlayFontSize || 32;
    fontSizeValue.textContent = overlayFontSize.value;
    overlayColor.value = status.config.overlayColor || "white";

    // Toggle overlay type options
    if (overlayType.value === "text") {
      textOverlayOptions.style.display = "block";
      urlOverlayOptions.style.display = "none";
    } else {
      textOverlayOptions.style.display = "none";
      urlOverlayOptions.style.display = "block";
    }

    // Update preview overlay
    currentOverlayConfig = {
      overlayEnabled: status.config.overlayEnabled || false,
      overlayType: status.config.overlayType || "text",
      overlayText: status.config.overlayText || "",
      customText2: status.config.customText2 || "",
      showTimestamp: status.config.showTimestamp || false,
      overlayUrl: status.config.overlayUrl || "",
      timestampPosition: status.config.timestampPosition || "bottom-right",
      titlePosition: status.config.titlePosition || "top-left",
      subtitlePosition: status.config.subtitlePosition || "top-left",
      overlayFontSize: status.config.overlayFontSize || 32,
      overlayColor: status.config.overlayColor || "white",
      overlayBackground: status.config.overlayBackground || "transparent",
      overlayBackgroundOpacity: status.config.overlayBackgroundOpacity || 70,
    };
    drawOverlay();
  }
});
