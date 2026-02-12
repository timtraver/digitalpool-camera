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
      console.log(
        `🔄 Custom dropdown changed: ${selectElement.id} = ${opt.value}`,
      );

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

// Helper function to update custom dropdown display when value is set programmatically
function updateCustomDropdownDisplay(selectElement) {
  const customDropdown = selectElement.parentElement.querySelector(
    ".custom-dropdown-selected",
  );
  if (customDropdown) {
    const selectedOption = selectElement.options[selectElement.selectedIndex];
    if (selectedOption) {
      customDropdown.textContent = selectedOption.text;
      customDropdown.dataset.value = selectedOption.value;

      // Update selected class in options
      const optionsContainer = selectElement.parentElement.querySelector(
        ".custom-dropdown-options",
      );
      if (optionsContainer) {
        optionsContainer
          .querySelectorAll(".custom-dropdown-option")
          .forEach((opt) => {
            if (opt.dataset.value === selectedOption.value) {
              opt.classList.add("selected");
            } else {
              opt.classList.remove("selected");
            }
          });
      }
    }
  }
}

// Initialize Socket.IO connection
const socket = io();
console.log("🔌 Socket.IO initialized:", socket);

// Connection status
const statusElement = document.getElementById("connectionStatus");

socket.on("connect", () => {
  statusElement.textContent = "Camera Connected";
  statusElement.className = "status status-connected";
  console.log("Connected to server");

  // Request camera configuration on connect
  socket.emit("getCameraConfig");
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

// Handle camera configuration from server
socket.on("cameraConfig", (data) => {
  if (data.success && data.config) {
    console.log("📸 Received camera configuration:", data.config);
    loadCameraConfigToUI(data.config);
  }
});

// Handle camera reset response
socket.on("cameraConfigReset", (data) => {
  if (data.success && data.config) {
    console.log("🔄 Camera reset to defaults:", data.config);
    loadCameraConfigToUI(data.config);
    alert("All camera settings have been reset to defaults!");
  }
});

// Pan/Tilt/Zoom Controls
// Define movement speeds
// Note: Camera step size is 3600 units = 1 degree, so minimum movement is 1 degree
const SMALL_MOVE = 1.0; // degrees for inner buttons (minimum step size)
const LARGE_MOVE = 5.0; // degrees for outer buttons

// Inner ring - Small movements
document.getElementById("panLeftSmall").addEventListener("click", () => {
  console.log("🔵 Pan Left (Small):", SMALL_MOVE);
  socket.emit("pan", { degrees: SMALL_MOVE });
});

document.getElementById("panRightSmall").addEventListener("click", () => {
  console.log("🔵 Pan Right (Small):", -SMALL_MOVE);
  socket.emit("pan", { degrees: -SMALL_MOVE });
});

document.getElementById("tiltUpSmall").addEventListener("click", () => {
  console.log("🔵 Tilt Up (Small):", SMALL_MOVE);
  socket.emit("tilt", { degrees: SMALL_MOVE });
});

document.getElementById("tiltDownSmall").addEventListener("click", () => {
  console.log("🔵 Tilt Down (Small):", -SMALL_MOVE);
  socket.emit("tilt", { degrees: -SMALL_MOVE });
});

// Outer ring - Large movements
document.getElementById("panLeftLarge").addEventListener("click", () => {
  console.log("🔷 Pan Left (Large):", LARGE_MOVE);
  socket.emit("pan", { degrees: LARGE_MOVE });
});

document.getElementById("panRightLarge").addEventListener("click", () => {
  console.log("🔷 Pan Right (Large):", -LARGE_MOVE);
  socket.emit("pan", { degrees: -LARGE_MOVE });
});

document.getElementById("tiltUpLarge").addEventListener("click", () => {
  console.log("🔷 Tilt Up (Large):", LARGE_MOVE);
  socket.emit("tilt", { degrees: LARGE_MOVE });
});

document.getElementById("tiltDownLarge").addEventListener("click", () => {
  console.log("🔷 Tilt Down (Large):", -LARGE_MOVE);
  socket.emit("tilt", { degrees: -LARGE_MOVE });
});

// Center reset button
document.getElementById("resetPos").addEventListener("click", () => {
  socket.emit("resetPosition");
});

// Zoom controls
const zoomLevel = document.getElementById("zoomLevel");
let currentZoom = 0;

if (zoomLevel) {
  zoomLevel.addEventListener("change", (e) => {
    const value = parseInt(e.target.value);
    // Clamp value between 0 and 12
    const clampedValue = Math.max(0, Math.min(12, value));
    if (value !== clampedValue) {
      e.target.value = clampedValue;
    }
    currentZoom = clampedValue;
    console.log(`🔍 Zoom level changed to: ${clampedValue}`);
    socket.emit("zoom", { level: clampedValue });
  });
}

const zoomInBtn = document.getElementById("zoomIn");
const zoomOutBtn = document.getElementById("zoomOut");

if (zoomInBtn) {
  zoomInBtn.addEventListener("click", () => {
    if (currentZoom < 12) {
      currentZoom++;
      if (zoomLevel) zoomLevel.value = currentZoom;
      socket.emit("zoom", { level: currentZoom });
    }
  });
}

if (zoomOutBtn) {
  zoomOutBtn.addEventListener("click", () => {
    if (currentZoom > 0) {
      currentZoom--;
      if (zoomLevel) zoomLevel.value = currentZoom;
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
    console.log(`🎚️  Slider changed: ${controlName} = ${value}`);
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
const exposureAbsoluteSlider = document.getElementById("exposureAbsolute");
const gainSlider = document.getElementById("gain");
const exposureAbsoluteValue = document.getElementById("exposureAbsoluteValue");
const gainValue = document.getElementById("gainValue");

// Function to enable/disable manual exposure controls based on auto mode
function updateExposureControlsState() {
  const isAuto = exposureAuto.value !== "1"; // 1 = Manual, anything else = Auto

  // Disable manual controls when auto is enabled
  if (exposureAbsoluteSlider) {
    exposureAbsoluteSlider.disabled = isAuto;
    exposureAbsoluteSlider.style.opacity = isAuto ? "0.5" : "1";
    exposureAbsoluteSlider.style.cursor = isAuto ? "not-allowed" : "pointer";

    // Find and dim the label
    const exposureLabel =
      exposureAbsoluteSlider.parentElement.querySelector("label");
    if (exposureLabel) {
      exposureLabel.style.opacity = isAuto ? "0.5" : "1";
    }

    // Dim the value display
    if (exposureAbsoluteValue) {
      exposureAbsoluteValue.style.opacity = isAuto ? "0.5" : "1";
    }
  }

  if (gainSlider) {
    gainSlider.disabled = isAuto;
    gainSlider.style.opacity = isAuto ? "0.5" : "1";
    gainSlider.style.cursor = isAuto ? "not-allowed" : "pointer";

    // Find and dim the label
    const gainLabel = gainSlider.parentElement.querySelector("label");
    if (gainLabel) {
      gainLabel.style.opacity = isAuto ? "0.5" : "1";
    }

    // Dim the value display
    if (gainValue) {
      gainValue.style.opacity = isAuto ? "0.5" : "1";
    }
  }

  console.log(
    `Exposure mode: ${isAuto ? "Auto" : "Manual"} - Manual controls ${isAuto ? "disabled" : "enabled"}`,
  );
}

if (exposureAuto) {
  exposureAuto.addEventListener("change", (e) => {
    const value = parseInt(e.target.value);
    socket.emit("setControl", { control: "exposure_auto", value: value });
    updateExposureControlsState(); // Update control states
  });

  // Set initial state
  updateExposureControlsState();
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

// Function to load camera configuration into UI
function loadCameraConfigToUI(config) {
  console.log("🔧 Loading camera config to UI...");

  // Image Quality controls
  if (config.brightness !== undefined) {
    document.getElementById("brightness").value = config.brightness;
    document.getElementById("brightnessValue").textContent = config.brightness;
  }
  if (config.contrast !== undefined) {
    document.getElementById("contrast").value = config.contrast;
    document.getElementById("contrastValue").textContent = config.contrast;
  }
  if (config.saturation !== undefined) {
    document.getElementById("saturation").value = config.saturation;
    document.getElementById("saturationValue").textContent = config.saturation;
  }
  if (config.sharpness !== undefined) {
    document.getElementById("sharpness").value = config.sharpness;
    document.getElementById("sharpnessValue").textContent = config.sharpness;
  }

  // Exposure controls
  if (config.exposure_auto !== undefined) {
    const exposureAutoSelect = document.getElementById("exposureAuto");
    exposureAutoSelect.value = config.exposure_auto;
    updateCustomDropdownDisplay(exposureAutoSelect);
    updateExposureControlsState();
  }
  if (config.exposure_absolute !== undefined) {
    document.getElementById("exposureAbsolute").value =
      config.exposure_absolute;
    document.getElementById("exposureAbsoluteValue").textContent =
      config.exposure_absolute;
  }
  if (config.gain !== undefined) {
    document.getElementById("gain").value = config.gain;
    document.getElementById("gainValue").textContent = config.gain;
  }
  if (config.backlight_compensation !== undefined) {
    document.getElementById("backlightCompensation").value =
      config.backlight_compensation;
    document.getElementById("backlightCompensationValue").textContent =
      config.backlight_compensation;
  }

  // White Balance controls
  if (config.white_balance_temperature_auto !== undefined) {
    document.getElementById("whiteBalanceAuto").checked =
      config.white_balance_temperature_auto === 1;
  }
  if (config.white_balance_temperature !== undefined) {
    document.getElementById("whiteBalanceTemp").value =
      config.white_balance_temperature;
    document.getElementById("whiteBalanceTempValue").textContent =
      config.white_balance_temperature;
  }

  // Focus controls
  if (config.focus_auto !== undefined) {
    document.getElementById("focusAuto").checked = config.focus_auto === 1;
  }
  if (config.focus_absolute !== undefined) {
    document.getElementById("focusAbsolute").value = config.focus_absolute;
    document.getElementById("focusAbsoluteValue").textContent =
      config.focus_absolute;
  }

  // Zoom control
  if (config.zoom_absolute !== undefined) {
    const zoomLevelInput = document.getElementById("zoomLevel");
    if (zoomLevelInput) {
      zoomLevelInput.value = config.zoom_absolute;
      currentZoom = config.zoom_absolute;
      console.log(`🔍 Loaded zoom level: ${config.zoom_absolute}`);
    }
  }

  console.log("✅ Camera config loaded to UI");
}

// Reset all settings
const resetAllBtn = document.getElementById("resetAll");
if (resetAllBtn) {
  resetAllBtn.addEventListener("click", async () => {
    if (confirm("Reset all camera settings to defaults?")) {
      // Send reset command to server
      socket.emit("resetCameraSettings");
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
const startBtnIcon = document.getElementById("startBtnIcon");
const startBtnText = document.getElementById("startBtnText");

// Track streaming state
let isCurrentlyStreaming = false;

// Update placeholder based on protocol
streamProtocol.addEventListener("change", () => {
  const protocol = streamProtocol.value;
  if (protocol === "udp") {
    streamDestination.placeholder =
      "udp://192.168.1.100:5000 or 192.168.1.100:5000";
  } else if (protocol === "srt") {
    streamDestination.placeholder = "srt://server:port";
  } else if (protocol === "rtmp") {
    streamDestination.placeholder = "rtmp://server/live/stream";
  }
});

// Start/Restart stream
startStreamBtn.addEventListener("click", async () => {
  // Check if currently streaming (button shows "Restart")
  const isRestart = !stopStreamBtn.disabled;

  if (isRestart) {
    console.log("Restarting stream...");
    streamStatusText.textContent = "Restarting...";
    streamStatusText.style.color = "#f59e0b";

    // Stop the stream first
    socket.emit("stopStream");

    // Wait for stream to stop, then start again
    setTimeout(() => {
      const config = {
        protocol: streamProtocol.value,
        destination: streamDestination.value,
        bitrate: parseInt(streamBitrate.value),
        width: 1920,
        height: 1080,
        framerate: 30,
        encoder: "nvv4l2h264enc",
      };

      console.log("Starting stream after restart with config:", config);
      socket.emit("startStream", config);
    }, 1500); // Wait 1.5 seconds for clean shutdown
  } else {
    // Normal start
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

    streamStatusText.textContent = "Starting...";
    streamStatusText.style.color = "#f59e0b";
  }
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

// Preview refresh notification
socket.on("previewRefreshNeeded", (data) => {
  console.log("Preview refresh needed:", data.message);
  // Show a subtle notification instead of alert
  const notification = document.createElement("div");
  notification.style.cssText = `
    position: fixed;
    top: 20px;
    right: 20px;
    background: rgba(18, 199, 255, 0.9);
    color: white;
    padding: 15px 20px;
    border-radius: 8px;
    box-shadow: 0 4px 6px rgba(0, 0, 0, 0.3);
    z-index: 10000;
    font-size: 14px;
    cursor: pointer;
  `;
  notification.textContent = "Stream stopped. Click to refresh preview.";
  notification.onclick = () => window.location.reload();
  document.body.appendChild(notification);

  // Auto-remove after 10 seconds
  setTimeout(() => {
    if (notification.parentElement) {
      notification.remove();
    }
  }, 10000);
});

// Stream status updates
socket.on("streamStatus", (status) => {
  console.log("Stream status:", status);

  isCurrentlyStreaming = status.isStreaming;

  // Show/hide preview source indicator
  const previewIndicator = document.getElementById("previewSourceIndicator");
  if (previewIndicator) {
    previewIndicator.style.display = status.isStreaming ? "block" : "none";
  }

  if (status.isStreaming) {
    // Change Start button to Restart button
    startStreamBtn.disabled = false;
    startBtnIcon.textContent = "🔄";
    startBtnText.textContent = "Restart";
    startStreamBtn.classList.remove("btn-start");
    startStreamBtn.classList.add("btn-restart");

    stopStreamBtn.disabled = false;
    streamStatusText.textContent = `Streaming (${status.config?.protocol?.toUpperCase()})`;
    streamStatusText.style.color = "#10b981";

    // Reload video stream to switch to GStreamer tee output
    // Add delay to ensure GStreamer TCP server is ready
    setTimeout(() => {
      const videoStream = document.getElementById("videoStream");
      if (videoStream) {
        console.log("🔄 Reloading video stream to show tee output...");

        // Force a complete reload by removing and re-adding the element
        const parent = videoStream.parentNode;
        const newImg = document.createElement("img");
        newImg.id = "videoStream";
        newImg.alt = "Camera Stream";
        newImg.src = "/video/stream?t=" + Date.now();

        parent.removeChild(videoStream);
        parent.appendChild(newImg);

        console.log("✅ Video stream element recreated");
      }
    }, 1000); // Increased delay to 1 second
  } else {
    // Change Restart button back to Start button
    startStreamBtn.disabled = false;
    startBtnIcon.textContent = "▶";
    startBtnText.textContent = "Start";
    startStreamBtn.classList.remove("btn-restart");
    startStreamBtn.classList.add("btn-start");

    stopStreamBtn.disabled = true;
    streamStatusText.textContent = "Not streaming";
    streamStatusText.style.color = "rgba(255, 255, 255, 0.7)";

    // Reload video stream to switch back to direct camera feed
    setTimeout(() => {
      const videoStream = document.getElementById("videoStream");
      if (videoStream) {
        console.log("🔄 Reloading video stream to show direct camera feed...");

        // Force a complete reload by removing and re-adding the element
        const parent = videoStream.parentNode;
        const newImg = document.createElement("img");
        newImg.id = "videoStream";
        newImg.alt = "Camera Stream";
        newImg.src = "/video/stream?t=" + Date.now();

        parent.removeChild(videoStream);
        parent.appendChild(newImg);

        console.log("✅ Video stream element recreated");
      }
    }, 500);
  }
});

// Stream error handler
socket.on("streamError", (data) => {
  console.error("Stream error:", data.error);
  // Only show error status if stream is not running
  // (some "errors" are just informational messages)
  if (!stopStreamBtn.disabled) {
    // Stream is not running, so this is a real error
    streamStatusText.textContent = "Stream error";
    streamStatusText.style.color = "#ef4444";
  }
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
const showTimestamp = document.getElementById("showTimestamp");
const overlayUrl = document.getElementById("overlayUrl");
const timestampPosition = document.getElementById("timestampPosition");
const titlePosition = document.getElementById("titlePosition");
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

// Initialize custom dropdowns for ALL select elements
console.log("🎨 Initializing custom dropdowns...");

// Overlay position dropdowns
createCustomDropdown(timestampPosition);
createCustomDropdown(titlePosition);

// Overlay style dropdowns
createCustomDropdown(overlayType);
createCustomDropdown(overlayColor);
createCustomDropdown(overlayBackground);

// Stream control dropdowns
createCustomDropdown(streamProtocol);
createCustomDropdown(streamBitrate);

// Camera control dropdowns
const exposureAutoSelect = document.getElementById("exposureAuto");
if (exposureAutoSelect) {
  createCustomDropdown(exposureAutoSelect);
}

console.log("✅ Custom dropdowns initialized");

console.log("🚀 app.js loaded!");

// Canvas overlay removed - preview now shows actual stream output via tee
// Overlay settings still work, they just apply to the GStreamer pipeline
const videoStream = document.getElementById("videoStream");
// const overlayCanvas = document.getElementById("overlayCanvas");
// const ctx = overlayCanvas.getContext("2d");

console.log("📺 Video element:", videoStream);
// console.log("🎨 Canvas element:", overlayCanvas);
// console.log("🖌️ Canvas context:", ctx);

// Debug elements
const canvasSizeSpan = document.getElementById("canvasSize");

console.log("🔧 Debug elements:", {
  canvasSizeSpan,
});

// Current overlay config
let currentOverlayConfig = {
  overlayEnabled: false,
  overlayType: "text",
  overlayText: "",
  showTimestamp: false,
  overlayUrl: "",
  timestampPosition: "bottom-right",
  titlePosition: "top-left",
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

// Canvas initialization disabled - overlay now rendered by GStreamer only
// let canvasInitialized = false;
// let initAttempts = 0;
// const MAX_INIT_ATTEMPTS = 50; // Try for 10 seconds

// function initializeCanvas() {
//   initAttempts++;
//   console.log(`🔄 Canvas init attempt ${initAttempts}/${MAX_INIT_ATTEMPTS}`);
//   const success = updateCanvasSize();
//   if (success && !canvasInitialized) {
//     canvasInitialized = true;
//     console.log("✅ Canvas initialized successfully!");
//     drawOverlay();
//   } else if (!canvasInitialized && initAttempts < MAX_INIT_ATTEMPTS) {
//     const delay = initAttempts < 10 ? 200 : 500;
//     setTimeout(initializeCanvas, delay);
//   } else if (initAttempts >= MAX_INIT_ATTEMPTS) {
//     console.error("❌ Failed to initialize canvas after", MAX_INIT_ATTEMPTS, "attempts");
//     console.error("Video element might not be loading. Check MJPEG stream.");
//   }
// }
// initializeCanvas();
// setTimeout(() => { if (!canvasInitialized) { initAttempts = 0; initializeCanvas(); } }, 2000);
// setTimeout(() => { if (!canvasInitialized) { initAttempts = 0; initializeCanvas(); } }, 5000);
// window.addEventListener("resize", () => { updateCanvasSize(); drawOverlay(); });

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

// Canvas overlay redraw disabled - overlays now rendered by GStreamer only
// setInterval(() => {
//   if (currentOverlayConfig.overlayEnabled) {
//     drawOverlay();
//   } else {
//     ctx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
//     if (urlOverlayIframe) {
//       urlOverlayIframe.style.display = "none";
//     }
//   }
// }, 100);

// Draw overlay on canvas - DISABLED
// Canvas overlay removed - preview now shows actual stream output via tee
function drawOverlay() {
  // Canvas overlay disabled - overlays are now only rendered by GStreamer
  // When streaming, the preview shows the actual tee output with overlays
  // When not streaming, the preview shows direct camera feed without overlays
  return;

  /* DISABLED CODE:
  // Removed verbose logging - was flooding console at 5fps
  // console.log("=== drawOverlay called ===");
  // console.log("Canvas dimensions:", overlayCanvas.width, "x", overlayCanvas.height);
  // console.log("Overlay config:", currentOverlayConfig);

  // Clear canvas
  ctx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);

  if (!currentOverlayConfig.overlayEnabled) {
    // console.log("Overlay disabled, clearing canvas");
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
  console.log("drawUrlOverlay called, URL:", currentOverlayConfig.overlayUrl);

  if (!currentOverlayConfig.overlayUrl) {
    console.log("No URL specified for overlay");
    if (urlOverlayIframe) {
      urlOverlayIframe.style.display = "none";
    }
    return;
  }

  // Create iframe if it doesn't exist
  if (!urlOverlayIframe) {
    console.log("Creating new iframe for URL overlay");
    urlOverlayIframe = document.createElement("iframe");
    urlOverlayIframe.id = "urlOverlayIframe";
    urlOverlayIframe.style.position = "absolute";
    urlOverlayIframe.style.top = "0";
    urlOverlayIframe.style.left = "0";
    urlOverlayIframe.style.width = "100%";
    urlOverlayIframe.style.height = "100%";
    urlOverlayIframe.style.border = "none";
    urlOverlayIframe.style.pointerEvents = "none"; // Don't capture mouse events
    urlOverlayIframe.style.zIndex = "20"; // Above canvas (canvas is z-index 10)
    urlOverlayIframe.style.background = "transparent";

    // Add load handler
    urlOverlayIframe.addEventListener("load", () => {
      console.log("✅ URL overlay loaded successfully");
    });

    // Add error handler
    urlOverlayIframe.addEventListener("error", () => {
      console.error(
        "❌ Failed to load URL overlay:",
        currentOverlayConfig.overlayUrl,
      );
    });

    overlayCanvas.parentElement.appendChild(urlOverlayIframe);
    console.log("Iframe appended to parent:", overlayCanvas.parentElement);
  }

  // Update iframe src if changed
  // Extract the path from the URL and use it directly (server proxies /tournaments)
  let proxyUrl;
  try {
    const url = new URL(currentOverlayConfig.overlayUrl);
    proxyUrl = url.pathname; // e.g., /tournaments/2026-wpba-classics-players-championship/overlay/table-1
  } catch (e) {
    console.error("Invalid overlay URL:", currentOverlayConfig.overlayUrl);
    return;
  }

  if (urlOverlayIframe.src !== window.location.origin + proxyUrl) {
    console.log("Loading URL overlay:", currentOverlayConfig.overlayUrl);
    console.log("Proxy URL:", proxyUrl);
    console.log("Using direct path (server proxies /tournaments)");
    urlOverlayIframe.src = proxyUrl;
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

  // console.log("Scale:", scale, "fontSize:", fontSize, "padding:", padding); // Removed - floods console at 5fps

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

    console.log(
      `📐 Position "${position}" → x:${xPos}, y:${yPos}, align:${textAlign}, baseline:${textBaseline}`,
    );
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

    // console.log(`Drew text "${text}" at position ${position} (${xPos}, ${yPos})`); // Removed - floods console at 5fps
  }

  // Draw timestamp if enabled
  if (currentOverlayConfig.showTimestamp) {
    const now = new Date();
    const timestamp = now.toLocaleString();
    console.log(
      `🕐 Drawing timestamp at position: ${currentOverlayConfig.timestampPosition}`,
    );
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

  // console.log("✅ Overlay drawing complete"); // Removed - floods console at 5fps
  */
}

// Helper function to apply overlay settings to server
function applyOverlaySettings() {
  const overlayConfig = {
    overlayEnabled: overlayEnabled.checked,
    overlayType: overlayType.value,
    overlayText: overlayText.value,
    showTimestamp: showTimestamp.checked,
    overlayUrl: overlayUrl.value,
    timestampPosition: timestampPosition.value,
    titlePosition: titlePosition.value,
    overlayFontSize: parseInt(overlayFontSize.value),
    overlayColor: overlayColor.value,
    overlayBackground: overlayBackground.value,
    overlayBackgroundOpacity: parseInt(overlayBackgroundOpacity.value),
  };

  console.log("Auto-applying overlay config:", overlayConfig);
  socket.emit("updateOverlay", overlayConfig);
}

// Live preview updates (update preview as user types/changes)
overlayEnabled.addEventListener("change", () => {
  currentOverlayConfig.overlayEnabled = overlayEnabled.checked;
  console.log("Overlay enabled changed:", overlayEnabled.checked);
  drawOverlay();
  applyOverlaySettings();
});

// Apply text changes after user stops typing (debounce)
let textInputTimeout;
overlayText.addEventListener("input", () => {
  currentOverlayConfig.overlayText = overlayText.value;
  drawOverlay();
  clearTimeout(textInputTimeout);
  textInputTimeout = setTimeout(() => {
    applyOverlaySettings();
  }, 1000);
});

showTimestamp.addEventListener("change", () => {
  currentOverlayConfig.showTimestamp = showTimestamp.checked;
  drawOverlay();
  applyOverlaySettings();
});

// Apply font size changes after user stops dragging (debounce)
let fontSizeTimeout;
overlayFontSize.addEventListener("input", () => {
  fontSizeValue.textContent = overlayFontSize.value + "px";
  currentOverlayConfig.overlayFontSize = parseInt(overlayFontSize.value);
  drawOverlay();
  clearTimeout(fontSizeTimeout);
  fontSizeTimeout = setTimeout(() => {
    applyOverlaySettings();
  }, 500);
});

overlayColor.addEventListener("change", () => {
  currentOverlayConfig.overlayColor = overlayColor.value;
  drawOverlay();
  applyOverlaySettings();
});

overlayBackground.addEventListener("change", () => {
  currentOverlayConfig.overlayBackground = overlayBackground.value;
  drawOverlay();
  applyOverlaySettings();
});

// Apply opacity changes after user stops dragging (debounce)
let opacityTimeout;
overlayBackgroundOpacity.addEventListener("input", () => {
  backgroundOpacityValue.textContent = overlayBackgroundOpacity.value + "%";
  currentOverlayConfig.overlayBackgroundOpacity = parseInt(
    overlayBackgroundOpacity.value,
  );
  drawOverlay();
  clearTimeout(opacityTimeout);
  opacityTimeout = setTimeout(() => {
    applyOverlaySettings();
  }, 500);
});

// Apply URL changes after user stops typing (debounce)
let urlInputTimeout;
overlayUrl.addEventListener("input", () => {
  currentOverlayConfig.overlayUrl = overlayUrl.value;
  drawOverlay();
  clearTimeout(urlInputTimeout);
  urlInputTimeout = setTimeout(() => {
    applyOverlaySettings();
  }, 1000);
});

// Position dropdowns
console.log(`🔍 Initial timestampPosition value: ${timestampPosition.value}`);
console.log(`🔍 Initial titlePosition value: ${titlePosition.value}`);

timestampPosition.addEventListener("change", () => {
  currentOverlayConfig.timestampPosition = timestampPosition.value;
  console.log(`📍 Timestamp position changed to: ${timestampPosition.value}`);
  drawOverlay();
  applyOverlaySettings();
});

titlePosition.addEventListener("change", () => {
  currentOverlayConfig.titlePosition = titlePosition.value;
  console.log(`📍 Title position changed to: ${titlePosition.value}`);
  drawOverlay();
  applyOverlaySettings();
});

// Overlay result handler
socket.on("overlayResult", (result) => {
  console.log("Overlay result:", result);
  if (result.success) {
    // Only show restart message if stream is currently running
    if (isCurrentlyStreaming) {
      alert(
        result.message || "Overlay settings updated. Restart stream to apply.",
      );
    }
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
    showTimestamp.checked = status.config.showTimestamp || false;
    overlayUrl.value = status.config.overlayUrl || "";

    // Set position dropdowns and update custom dropdown displays
    timestampPosition.value = status.config.timestampPosition || "bottom-right";
    titlePosition.value = status.config.titlePosition || "top-left";
    updateCustomDropdownDisplay(timestampPosition);
    updateCustomDropdownDisplay(titlePosition);

    overlayFontSize.value = status.config.overlayFontSize || 32;
    fontSizeValue.textContent = overlayFontSize.value + "px";

    overlayColor.value = status.config.overlayColor || "white";
    updateCustomDropdownDisplay(overlayColor);

    overlayBackground.value = status.config.overlayBackground || "transparent";
    updateCustomDropdownDisplay(overlayBackground);

    overlayBackgroundOpacity.value =
      status.config.overlayBackgroundOpacity || 70;
    backgroundOpacityValue.textContent = overlayBackgroundOpacity.value + "%";

    overlayType.value = status.config.overlayType || "text";
    updateCustomDropdownDisplay(overlayType);

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
      showTimestamp: status.config.showTimestamp || false,
      overlayUrl: status.config.overlayUrl || "",
      timestampPosition: status.config.timestampPosition || "bottom-right",
      titlePosition: status.config.titlePosition || "top-left",
      overlayFontSize: status.config.overlayFontSize || 32,
      overlayColor: status.config.overlayColor || "white",
      overlayBackground: status.config.overlayBackground || "transparent",
      overlayBackgroundOpacity: status.config.overlayBackgroundOpacity || 70,
    };
    drawOverlay();
  }
});

// Load stream configuration on page load
async function loadStreamConfig() {
  try {
    const response = await fetch("/api/stream/config");
    const data = await response.json();
    if (data.success && data.config) {
      console.log("📡 Loaded stream config:", data.config);

      // Update UI with saved settings
      streamProtocol.value = data.config.protocol || "rtmp";
      streamDestination.value = data.config.destination || "";
      streamBitrate.value = data.config.bitrate || 5000000;

      // Update custom dropdowns
      const protocolDropdown = streamProtocol.parentElement.querySelector(
        ".custom-dropdown-selected",
      );
      if (protocolDropdown) {
        const protocolOption =
          streamProtocol.options[streamProtocol.selectedIndex];
        protocolDropdown.textContent = protocolOption.text;
        protocolDropdown.dataset.value = protocolOption.value;
      }

      const bitrateDropdown = streamBitrate.parentElement.querySelector(
        ".custom-dropdown-selected",
      );
      if (bitrateDropdown) {
        const bitrateOption =
          streamBitrate.options[streamBitrate.selectedIndex];
        bitrateDropdown.textContent = bitrateOption.text;
        bitrateDropdown.dataset.value = bitrateOption.value;
      }

      // Update placeholder
      if (data.config.protocol === "srt") {
        streamDestination.placeholder = "srt://server:port";
      } else if (data.config.protocol === "rtmp") {
        streamDestination.placeholder = "rtmp://server/live/stream";
      }
    }
  } catch (error) {
    console.error("❌ Error loading stream config:", error);
  }
}

// Load stream config on page load
loadStreamConfig();
