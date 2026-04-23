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
  socket.emit("getStartupPosition");
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
    // Clear the startup/home position display since it was also reset
    const startupPosInfo = document.getElementById("startupPosInfo");
    if (startupPosInfo) {
      startupPosInfo.textContent = "No home position set";
    }
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

// Zoom controls - range slider
const zoomLevel = document.getElementById("zoomLevel");
const zoomLevelValue = document.getElementById("zoomLevelValue");
let currentZoom = 0;

if (zoomLevel) {
  zoomLevel.addEventListener("input", (e) => {
    const value = parseInt(e.target.value);
    currentZoom = value;
    if (zoomLevelValue) zoomLevelValue.textContent = value;
    console.log(`🔍 Zoom level changed to: ${value}`);
    socket.emit("zoom", { level: value });
  });
}

// Startup position controls
const setStartupBtn = document.getElementById("setStartupPosition");
const startupPosInfo = document.getElementById("startupPosInfo");

if (setStartupBtn) {
  setStartupBtn.addEventListener("click", () => {
    socket.emit("setStartupPosition");
  });
}

socket.on("startupPositionSet", (data) => {
  if (data.success) {
    const pos = data.position;
    if (startupPosInfo) {
      startupPosInfo.textContent = `Startup: pan=${pos.pan_absolute}, tilt=${pos.tilt_absolute}, zoom=${pos.zoom_absolute}`;
    }
    console.log("📌 Startup position saved:", pos);
  }
});

socket.on("startupPosition", (data) => {
  if (data.position && startupPosInfo) {
    const pos = data.position;
    startupPosInfo.textContent = `Startup: pan=${pos.pan_absolute}, tilt=${pos.tilt_absolute}, zoom=${pos.zoom_absolute}`;
  }
});

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
    socket.emit("setControl", { control: "auto_exposure", value: value });
    updateExposureControlsState(); // Update control states
  });

  // Set initial state
  updateExposureControlsState();
}

createSliderControl(
  "exposure_time_absolute",
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
      control: "white_balance_automatic",
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
    socket.emit("setControl", { control: "focus_automatic_continuous", value: value });
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
  if (config.auto_exposure !== undefined) {
    const exposureAutoSelect = document.getElementById("exposureAuto");
    exposureAutoSelect.value = config.auto_exposure;
    updateCustomDropdownDisplay(exposureAutoSelect);
    updateExposureControlsState();
  }
  if (config.exposure_time_absolute !== undefined) {
    document.getElementById("exposureAbsolute").value =
      config.exposure_time_absolute;
    document.getElementById("exposureAbsoluteValue").textContent =
      config.exposure_time_absolute;
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
  if (config.white_balance_automatic !== undefined) {
    document.getElementById("whiteBalanceAuto").checked =
      config.white_balance_automatic === 1;
  }
  if (config.white_balance_temperature !== undefined) {
    document.getElementById("whiteBalanceTemp").value =
      config.white_balance_temperature;
    document.getElementById("whiteBalanceTempValue").textContent =
      config.white_balance_temperature;
  }

  // Focus controls
  if (config.focus_automatic_continuous !== undefined) {
    document.getElementById("focusAuto").checked = config.focus_automatic_continuous === 1;
  }
  if (config.focus_absolute !== undefined) {
    document.getElementById("focusAbsolute").value = config.focus_absolute;
    document.getElementById("focusAbsoluteValue").textContent =
      config.focus_absolute;
  }

  // Zoom control
  if (config.zoom_absolute !== undefined) {
    const zoomLevelInput = document.getElementById("zoomLevel");
    const zoomValueDisplay = document.getElementById("zoomLevelValue");
    if (zoomLevelInput) {
      zoomLevelInput.value = config.zoom_absolute;
      currentZoom = config.zoom_absolute;
      if (zoomValueDisplay) zoomValueDisplay.textContent = config.zoom_absolute;
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
const audioEnabledCheckbox = document.getElementById("audioEnabled");
const startStreamBtn = document.getElementById("startStream");
const stopStreamBtn = document.getElementById("stopStream");
const streamStatusText = document.getElementById("streamStatusText");
const streamStatusBar = document.getElementById("streamStatus");
const startBtnIcon = document.getElementById("startBtnIcon");
const startBtnText = document.getElementById("startBtnText");
const connectionInfoBox = document.getElementById("connectionInfoBox");
const connectionUrlEl = document.getElementById("connectionUrl");
const connectionInfoExtra = document.getElementById("connectionInfoExtra");
const destinationRow = document.getElementById("destinationRow");
const copyConnectionUrlBtn = document.getElementById("copyConnectionUrl");

// Track streaming state
let isCurrentlyStreaming = false;
// Track device IP for connection info
let deviceLocalIP = null;

// Helper: update the connection info box based on protocol and IP
function updateConnectionInfo(protocol, ip) {
  const resolvedIP = ip || deviceLocalIP || "device-ip";
  if (protocol === "rtsp") {
    connectionInfoBox.style.display = "block";
    destinationRow.style.display = "none";
    connectionUrlEl.textContent = `rtsp://${resolvedIP}:8554/live`;
    connectionInfoExtra.innerHTML =
      `<span style="color:rgba(255,255,255,0.45);font-size:10px">` +
      `Also: HLS → <code style="font-size:10px">http://${resolvedIP}:8888/live</code>` +
      `</span>`;
  } else if (protocol === "srt") {
    connectionInfoBox.style.display = "block";
    destinationRow.style.display = "none";
    connectionUrlEl.textContent = `srt://${resolvedIP}:8891`;
    connectionInfoExtra.innerHTML =
      `<span style="color:rgba(255,255,255,0.45);font-size:10px">` +
      `Listener mode — clients connect directly to this device` +
      `</span>`;
  } else {
    // RTMP push — show destination field, hide connection info box
    connectionInfoBox.style.display = "none";
    destinationRow.style.display = "";
  }
}

// Copy connection URL to clipboard
if (copyConnectionUrlBtn) {
  copyConnectionUrlBtn.addEventListener("click", () => {
    const url = connectionUrlEl ? connectionUrlEl.textContent : "";
    navigator.clipboard.writeText(url).then(() => {
      copyConnectionUrlBtn.textContent = "✅";
      setTimeout(() => { copyConnectionUrlBtn.textContent = "📋"; }, 1500);
    }).catch(() => {
      // Fallback
      const ta = document.createElement("textarea");
      ta.value = url;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      copyConnectionUrlBtn.textContent = "✅";
      setTimeout(() => { copyConnectionUrlBtn.textContent = "📋"; }, 1500);
    });
  });
}

// Initialize connection info box on page load with the default protocol selection
updateConnectionInfo(streamProtocol.value, deviceLocalIP);

// Helper to update stream status display
function setStreamStatus(state, text) {
  streamStatusBar.className = "stream-status-bar";
  switch (state) {
    case "idle":
      streamStatusBar.classList.add("status-idle");
      streamStatusText.textContent = "⏹ " + text;
      break;
    case "starting":
      streamStatusBar.classList.add("status-starting");
      streamStatusText.textContent = "⏳ " + text;
      break;
    case "stopping":
      streamStatusBar.classList.add("status-stopping");
      streamStatusText.textContent = "⏳ " + text;
      break;
    case "live":
      streamStatusBar.classList.add("status-live");
      streamStatusText.textContent = "🔴 " + text;
      break;
    case "error":
      streamStatusBar.classList.add("status-error");
      streamStatusText.textContent = "⚠️ " + text;
      break;
  }
}

// Update UI when protocol changes
streamProtocol.addEventListener("change", () => {
  const protocol = streamProtocol.value;
  updateConnectionInfo(protocol, deviceLocalIP);
  // Also update custom dropdown display
  const protocolDropdown = streamProtocol.parentElement.querySelector(".custom-dropdown-selected");
  if (protocolDropdown) {
    const opt = streamProtocol.options[streamProtocol.selectedIndex];
    protocolDropdown.textContent = opt.text;
    protocolDropdown.dataset.value = opt.value;
  }
});

// Start/Restart stream
startStreamBtn.addEventListener("click", async () => {
  // Check if currently streaming (button shows "Restart")
  const isRestart = !stopStreamBtn.disabled;

  // Disable both buttons immediately during transition
  startStreamBtn.disabled = true;
  stopStreamBtn.disabled = true;

  if (isRestart) {
    console.log("Restarting stream...");
    // Let the server handle the full stop→start cycle atomically.
    // The browser stays on "Restarting…" the whole time; no intermediate
    // MJPEG preview is opened, so there's no double-stream issue.
    const config = {
      protocol: streamProtocol.value,
      destination: streamDestination.value,
      bitrate: parseInt(streamBitrate.value),
      audioEnabled: audioEnabledCheckbox.checked,
      width: 1920,
      height: 1080,
      framerate: 30,
    };
    console.log("Restarting stream with config:", config);
    socket.emit("restartStream", config);
  } else {
    // Normal start
    const config = {
      protocol: streamProtocol.value,
      destination: streamDestination.value,
      bitrate: parseInt(streamBitrate.value),
      audioEnabled: audioEnabledCheckbox.checked,
      width: 1920,
      height: 1080,
      framerate: 30,
    };



    console.log("Starting stream with config:", config);
    socket.emit("startStream", config);
  }
});

// Stop stream
stopStreamBtn.addEventListener("click", () => {
  console.log("Stopping stream");
  startStreamBtn.disabled = true;
  stopStreamBtn.disabled = true;
  socket.emit("stopStream");
});

// Stream result handler
socket.on("streamResult", (result) => {
  console.log("Stream result:", result);
  if (!result.success) {
    alert(`Stream error: ${result.error}`);
    startStreamBtn.disabled = false;
    stopStreamBtn.disabled = true;
    setStreamStatus("error", "Stream Error");
  }
});

// Idle preview refresh — server killed the preview, reconnect with updated settings
socket.on("refreshIdlePreview", () => {
  if (!isCurrentlyStreaming) {
    console.log("🔄 Refreshing idle preview for overlay changes...");
    const previewStatus = document.getElementById("overlayPreviewStatus");
    if (previewStatus) previewStatus.style.display = "block";
    // Small delay to let the old GStreamer process fully die
    setTimeout(() => {
      switchToMJPEGPreview(() => {
        // Callback fires when the preview image actually loads
        if (previewStatus) previewStatus.style.display = "none";
      });
    }, 400);
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

  // Update preview source indicator
  const previewIndicator = document.getElementById("previewSourceIndicator");
  if (previewIndicator) {
    if (status.isStreaming) {
      previewIndicator.textContent = "📡 Live Stream Preview";
      previewIndicator.style.display = "block";
      previewIndicator.style.background = "rgba(18, 199, 255, 0.9)";
    } else {
      previewIndicator.textContent = "📹 Raw Camera View";
      previewIndicator.style.display = "block";
      previewIndicator.style.background = "rgba(139, 92, 246, 0.9)";
    }
  }

  // Hide "needs restart" banner when stream is (re)starting
  if (status.status === "starting" || status.status === "preparing") {
    overlayNeedsRestart.style.display = "none";
  }

  // Handle granular statuses
  if (status.status === "restarting") {
    startStreamBtn.disabled = true;
    stopStreamBtn.disabled = true;
    setStreamStatus("starting", "Restarting Stream...");
    // Cancel the existing TCP preview img RIGHT NOW so that when GStreamer
    // dies and the HTTP response ends, the img's onerror retry logic does
    // NOT open a new /video/tcp-preview connection during the restart.
    cancelCurrentPreviewImg();
    // Also discard any queued preview-switch timers.
    if (_tcpPreviewTimeout) { clearTimeout(_tcpPreviewTimeout); _tcpPreviewTimeout = null; }
    if (_mjpegPreviewTimeout) { clearTimeout(_mjpegPreviewTimeout); _mjpegPreviewTimeout = null; }
    return;
  }

  if (status.status === "starting") {
    startStreamBtn.disabled = true;
    stopStreamBtn.disabled = true;
    setStreamStatus("starting", "Starting Stream...");
    return;
  }

  if (status.status === "preparing") {
    startStreamBtn.disabled = true;
    stopStreamBtn.disabled = true;
    setStreamStatus("starting", "Preparing Stream...");
    return;
  }

  if (status.status === "stopping") {
    startStreamBtn.disabled = true;
    stopStreamBtn.disabled = true;
    setStreamStatus("stopping", "Stopping Stream...");
    return;
  }

  if (status.isStreaming) {
    // Change Start button to Restart button
    startStreamBtn.disabled = false;
    startBtnIcon.textContent = "🔄";
    startBtnText.textContent = "Restart";
    startStreamBtn.classList.remove("btn-start");
    startStreamBtn.classList.add("btn-restart");

    stopStreamBtn.disabled = false;
    const liveProtocol = status.config?.protocol || "rtsp";
    const liveLabel = liveProtocol === "rtsp" ? "RTSP Server" : liveProtocol === "srt" ? "SRT Server" : "RTMP Push";
    setStreamStatus("live", `Streaming LIVE — ${liveLabel}`);

    // Update connection info with actual IP from server status
    if (status.localIP) deviceLocalIP = status.localIP;
    if (status.connectionUrl && connectionUrlEl) {
      connectionUrlEl.textContent = status.connectionUrl;
    } else {
      updateConnectionInfo(liveProtocol, deviceLocalIP);
    }

    // Switch to TCP preview when streaming.
    // Cancel any stale pending switch first so we never queue two connections.
    if (_tcpPreviewTimeout) {
      clearTimeout(_tcpPreviewTimeout);
      _tcpPreviewTimeout = null;
    }
    // Also cancel any pending MJPEG switch that might race with us.
    if (_mjpegPreviewTimeout) {
      clearTimeout(_mjpegPreviewTimeout);
      _mjpegPreviewTimeout = null;
    }
    _tcpPreviewTimeout = setTimeout(() => {
      _tcpPreviewTimeout = null;
      switchToHLSPreview(); // Function switches to MJPEG-over-TCP on port 8555
    }, 2000); // Wait for GStreamer TCP server to start (has retry logic)
  } else {
    // Change Restart button back to Start button
    startStreamBtn.disabled = false;
    startBtnIcon.textContent = "▶";
    startBtnText.textContent = "Start";
    startStreamBtn.classList.remove("btn-restart");
    startStreamBtn.classList.add("btn-start");

    stopStreamBtn.disabled = true;
    setStreamStatus("idle", "Not Streaming");
    overlayNeedsRestart.style.display = "none";

    // Switch back to MJPEG preview when not streaming.
    // Cancel any stale TCP preview switch that might be pending.
    if (_tcpPreviewTimeout) {
      clearTimeout(_tcpPreviewTimeout);
      _tcpPreviewTimeout = null;
    }
    if (_mjpegPreviewTimeout) {
      clearTimeout(_mjpegPreviewTimeout);
      _mjpegPreviewTimeout = null;
    }
    _mjpegPreviewTimeout = setTimeout(() => {
      _mjpegPreviewTimeout = null;
      switchToMJPEGPreview();
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
    setStreamStatus("error", "Stream Error");
  }
});

// Get initial stream status on connect
socket.on("connect", () => {
  socket.emit("getStreamStatus");
});

// ============ OVERLAY CONTROLS ============

const overlayEnabled = document.getElementById("overlayEnabled");
const overlayType = document.getElementById("overlayType");
const urlOverlayOptions = document.getElementById("urlOverlayOptions");
const overlayText = document.getElementById("overlayText");
const showTimestamp = document.getElementById("showTimestamp");
const overlayUrl = document.getElementById("overlayUrl");
const timestampPosition = document.getElementById("timestampPosition");
const timestampFormat = document.getElementById("timestampFormat");
const titlePosition = document.getElementById("titlePosition");
// Per-element formatting controls
const titleFontSize = document.getElementById("titleFontSize");
const titleColor = document.getElementById("titleColor");
const titleBackground = document.getElementById("titleBackground");
const timestampFontSize = document.getElementById("timestampFontSize");
const timestampColor = document.getElementById("timestampColor");
const timestampBackground = document.getElementById("timestampBackground");
// Hidden backward-compat fields (synced from per-element values)
const overlayFontSize = document.getElementById("overlayFontSize");
const overlayColor = document.getElementById("overlayColor");
const overlayBackground = document.getElementById("overlayBackground");
const remoteOverlayEnabled = document.getElementById("remoteOverlayEnabled");
const overlayZoom = document.getElementById("overlayZoom");
const overlayZoomValue = document.getElementById("overlayZoomValue");
const titleOptions = document.getElementById("titleOptions");
const timestampOptions = document.getElementById("timestampOptions");
const titleFormatToggle = document.getElementById("titleFormatToggle");
const timestampFormatToggle = document.getElementById("timestampFormatToggle");
const overlayNeedsRestart = document.getElementById("overlayNeedsRestart");

// Initialize custom dropdowns for ALL select elements
console.log("🎨 Initializing custom dropdowns...");

// Overlay position dropdowns
createCustomDropdown(timestampPosition);
createCustomDropdown(titlePosition);

// Per-element style dropdowns
createCustomDropdown(titleColor);
createCustomDropdown(titleBackground);
createCustomDropdown(timestampColor);
createCustomDropdown(timestampBackground);

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

// Video preview switching functions
let hlsPlayer = null;

// Pending preview-switch timeout handles — only one of each should ever be queued
// at a time, so we cancel any stale timer before scheduling a new one.
let _tcpPreviewTimeout = null;
let _mjpegPreviewTimeout = null;

/**
 * Mark the current preview img element as cancelled so its internal onerror
 * retry loop stops opening new connections, then clear its src.
 * Call this before any operation that will replace or restart the stream.
 */
function cancelCurrentPreviewImg() {
  for (const id of ["videoStream", "videoStreamNew"]) {
    const el = document.getElementById(id);
    if (el) {
      el._cancelled = true;
      el.src = "";
      el.remove();
    }
  }
}

function switchToHLSPreview() {
  console.log("🔄 Switching to TCP preview (MJPEG over TCP)...");
  const container = document.querySelector(".video-container");
  const oldElement = document.getElementById("videoStream");

  console.log("📦 Container:", container);
  console.log("🗑️  Old element:", oldElement);

  // Cancel and remove any existing preview elements (including in-flight transitions).
  // Setting _cancelled=true stops their internal onerror retry timers from firing.
  cancelCurrentPreviewImg();

  // Destroy HLS player if it exists
  if (hlsPlayer) {
    hlsPlayer.destroy();
    hlsPlayer = null;
    console.log("✅ Destroyed HLS player");
  }

  // Create img element for MJPEG from TCP server
  const img = document.createElement("img");
  img.id = "videoStream";
  img.alt = "Camera Stream";
  const previewUrl = "/video/tcp-preview?t=" + Date.now();
  img.src = previewUrl;
  img.style.width = "100%";
  img.style.height = "100%";
  img.style.objectFit = "contain";
  img.style.display = "block"; // Ensure it's visible

  console.log("🖼️  Created new img element with src:", previewUrl);

  // Retry if TCP server isn't ready yet — but ONLY if this element hasn't
  // been cancelled (i.e. the stream wasn't restarted before the timer fired).
  let retryCount = 0;
  img.onerror = function(e) {
    if (img._cancelled) return; // stream restarted — don't open another connection
    retryCount++;
    console.error(`❌ TCP preview error (attempt ${retryCount}/5):`, e);
    if (retryCount < 5) {
      console.log(`⚠️  TCP preview not ready, retrying (${retryCount}/5)...`);
      setTimeout(() => {
        if (img._cancelled) return; // double-check before the delayed src assignment
        const newUrl = "/video/tcp-preview?t=" + Date.now();
        console.log("🔄 Retrying with URL:", newUrl);
        img.src = newUrl;
      }, 1000);
    } else {
      console.error("❌ TCP preview failed after 5 retries");
      console.error("💡 Try accessing http://" + window.location.host + "/video/tcp-preview directly");
    }
  };

  img.onload = function() {
    console.log("✅ TCP preview loaded successfully!");
    console.log("📐 Image dimensions:", img.naturalWidth, "x", img.naturalHeight);
  };

  container.insertBefore(img, container.firstChild);
  console.log("✅ Inserted img into container");
  console.log("📊 Container children:", container.children.length);
}

function switchToMJPEGPreview(onLoaded) {
  console.log("🔄 Switching to MJPEG preview...");
  const container = document.querySelector(".video-container");
  const oldElement = document.getElementById("videoStream");

  if (hlsPlayer) {
    hlsPlayer.destroy();
    hlsPlayer = null;
  }

  // Clean up any in-flight transition elements from a previous call
  // (prevents duplicate frames when refreshIdlePreview fires multiple times)
  const staleNew = document.getElementById("videoStreamNew");
  if (staleNew) {
    console.log("🧹 Removing stale in-flight preview element");
    staleNew.src = ""; // stop the old MJPEG connection
    staleNew.remove();
  }

  // Create new img element for MJPEG with temporary ID
  const img = document.createElement("img");
  img.id = "videoStreamNew";
  img.alt = "Camera Stream";

  // Pass overlay setting as query parameter
  // Overlays are enabled if any individual overlay checkbox is on
  const overlaysEnabled = overlayEnabled.checked || showTimestamp.checked || remoteOverlayEnabled.checked;
  img.src = `/video/stream?overlays=${overlaysEnabled}&t=${Date.now()}`;

  // Position absolutely over the old element to prevent layout shift
  img.style.position = "absolute";
  img.style.top = "0";
  img.style.left = "0";
  img.style.width = "100%";
  img.style.height = "100%";
  img.style.objectFit = "contain";
  img.style.opacity = "0";
  img.style.transition = "opacity 0.3s ease-in-out";
  img.style.zIndex = "1"; // Place new image above old one

  // Keep old element visible during transition
  if (oldElement) {
    oldElement.style.zIndex = "0";
  }

  // When new stream loads, swap elements smoothly
  img.onload = function() {
    // Fade in new stream
    img.style.opacity = "1";

    // After fade completes, swap the elements
    setTimeout(() => {
      // Remove absolute positioning from new element
      img.style.position = "";
      img.style.top = "";
      img.style.left = "";
      img.style.height = "auto"; // Let it size naturally
      img.style.zIndex = "";

      // Give new element the proper ID
      img.id = "videoStream";

      // Remove old element
      if (oldElement && oldElement.parentElement) {
        oldElement.remove();
      }

      console.log(`✅ MJPEG preview loaded (overlays: ${overlaysEnabled})`);
      if (typeof onLoaded === "function") onLoaded();
    }, 350);
  };

  // Handle error case - if new stream fails to load, keep old one
  img.onerror = function() {
    console.error("❌ Failed to load new preview, keeping old one");
    if (img.parentElement) {
      img.remove();
    }
    // Restore old element's z-index
    if (oldElement) {
      oldElement.style.zIndex = "";
    }
    if (typeof onLoaded === "function") onLoaded();
  };

  // Insert new element into container (will be positioned over old one)
  if (oldElement) {
    container.insertBefore(img, oldElement);
  } else {
    container.insertBefore(img, container.firstChild);
  }
}

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
  remoteOverlayEnabled: false,
  overlayUrl: "",
  timestampPosition: "bottom-right",
  titlePosition: "top-left",
  // Per-element formatting
  titleFontSize: 32,
  titleColor: "white",
  titleBackground: "transparent",
  timestampFontSize: 24,
  timestampColor: "white",
  timestampBackground: "transparent",
  // Legacy shared (kept for backward compat with server)
  overlayFontSize: 32,
  overlayColor: "white",
  overlayBackground: "transparent",
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

// Helper: show/hide sub-options based on checkbox state
function updateOverlayVisibility() {
  // Remote overlay URL options - always visible, but dimmed when unchecked
  urlOverlayOptions.style.opacity = remoteOverlayEnabled.checked ? "1" : "0.4";
  urlOverlayOptions.style.pointerEvents = remoteOverlayEnabled.checked ? "" : "none";
}
updateOverlayVisibility();

// Format toggle buttons — click to expand/collapse per-element formatting
titleFormatToggle.addEventListener("click", () => {
  const open = titleOptions.style.display === "none";
  titleOptions.style.display = open ? "" : "none";
  titleFormatToggle.classList.toggle("active", open);
});
timestampFormatToggle.addEventListener("click", () => {
  const open = timestampOptions.style.display === "none";
  timestampOptions.style.display = open ? "" : "none";
  timestampFormatToggle.classList.toggle("active", open);
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
  const padding = 20 * scale;

  // Get background color for a given setting
  function getBackgroundColor(bgSetting) {
    return bgSetting === "shaded" ? "rgba(0, 0, 0, 0.7)" : "rgba(0, 0, 0, 0)";
  }

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

  // Helper function to draw single text element with per-element styling
  function drawSingleText(text, font, position, color, bgSetting) {
    const { xPos, yPos, textAlign, textBaseline } = getPositionCoords(position);
    const bgColor = getBackgroundColor(bgSetting);

    ctx.textAlign = textAlign;
    ctx.textBaseline = textBaseline;
    ctx.font = font;

    const metrics = ctx.measureText(text);
    const textWidth = metrics.width;
    const fSize = parseInt(font.match(/([0-9]+)px/)?.[1] || "16");

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
      bgHeight = fSize + padding / 2;
    } else if (textBaseline === "bottom") {
      bgY = yPos - fSize - padding / 4;
      bgHeight = fSize + padding / 2;
    } else {
      bgY = yPos - fSize / 2 - padding / 4;
      bgHeight = fSize + padding / 2;
    }

    // Draw background if not transparent
    if (bgColor !== "rgba(0, 0, 0, 0)") {
      ctx.fillStyle = bgColor;
      ctx.fillRect(bgX, bgY, bgWidth, bgHeight);
    }

    // Draw text
    ctx.fillStyle = color;
    ctx.fillText(text, xPos, yPos);
  }

  // Draw timestamp if enabled
  if (currentOverlayConfig.showTimestamp) {
    const now = new Date();
    const timestamp = now.toLocaleString();
    const tsFontSize = Math.floor((currentOverlayConfig.timestampFontSize || 24) * scale);
    drawSingleText(
      timestamp,
      `bold ${tsFontSize}px Sans-serif`,
      currentOverlayConfig.timestampPosition,
      currentOverlayConfig.timestampColor || "white",
      currentOverlayConfig.timestampBackground || "transparent",
    );
  }

  // Draw main text (title)
  if (currentOverlayConfig.overlayText) {
    const titleFs = Math.floor((currentOverlayConfig.titleFontSize || 32) * scale);
    drawSingleText(
      currentOverlayConfig.overlayText,
      `bold ${titleFs}px Sans-serif`,
      currentOverlayConfig.titlePosition,
      currentOverlayConfig.titleColor || "white",
      currentOverlayConfig.titleBackground || "transparent",
    );
  }

  // console.log("✅ Overlay drawing complete"); // Removed - floods console at 5fps
  */
}

// Helper function to apply overlay settings to server
function applyOverlaySettings() {
  // Derive overlayType from which checkboxes are active
  const hasRemote = remoteOverlayEnabled.checked;
  const overlayConfig = {
    overlayEnabled: overlayEnabled.checked,
    overlayType: hasRemote ? "url" : "text",
    overlayText: overlayText.value,
    showTimestamp: showTimestamp.checked,
    remoteOverlayEnabled: remoteOverlayEnabled.checked,
    overlayUrl: overlayUrl.value,
    timestampPosition: timestampPosition.value,
    timestampFormat: timestampFormat.value,
    titlePosition: titlePosition.value,
    // Per-element formatting
    titleFontSize: parseInt(titleFontSize.value),
    titleColor: titleColor.value,
    titleBackground: titleBackground.value,
    timestampFontSize: parseInt(timestampFontSize.value),
    timestampColor: timestampColor.value,
    timestampBackground: timestampBackground.value,
    // Legacy shared fields (backward compat)
    overlayFontSize: parseInt(titleFontSize.value),
    overlayColor: titleColor.value,
    overlayBackground: titleBackground.value,
    overlayZoom: parseInt(overlayZoom.value),
  };

  console.log("Saving overlay config:", overlayConfig);
  socket.emit("updateOverlay", overlayConfig);

  // Show "needs restart" banner if currently streaming
  if (isCurrentlyStreaming) {
    overlayNeedsRestart.style.display = "";
  }

  // Show "Updating preview..." immediately when not streaming
  // (the banner will be hidden by the refreshIdlePreview handler once the preview loads)
  if (!isCurrentlyStreaming) {
    const previewStatus = document.getElementById("overlayPreviewStatus");
    if (previewStatus) {
      previewStatus.style.display = "block";
      console.log("🔄 Showing 'Updating preview' banner immediately");
    }
  }
}

// Live preview updates (update preview as user types/changes)
overlayEnabled.addEventListener("change", () => {
  currentOverlayConfig.overlayEnabled = overlayEnabled.checked;
  console.log("Title overlay changed:", overlayEnabled.checked);
  updateOverlayVisibility();
  drawOverlay();
  if (!isCurrentlyStreaming) {
    const ps = document.getElementById("overlayPreviewStatus");
    if (ps) ps.style.display = "block";
  }
  applyOverlaySettings();
});

remoteOverlayEnabled.addEventListener("change", () => {
  currentOverlayConfig.remoteOverlayEnabled = remoteOverlayEnabled.checked;
  console.log("Remote overlay changed:", remoteOverlayEnabled.checked);
  updateOverlayVisibility();
  drawOverlay();
  // Show "Updating preview" banner immediately — don't wait for server round-trip
  if (!isCurrentlyStreaming) {
    const ps = document.getElementById("overlayPreviewStatus");
    if (ps) ps.style.display = "block";
  }
  applyOverlaySettings();
});

// Apply text changes when user leaves the field or presses Enter
overlayText.addEventListener("input", () => {
  currentOverlayConfig.overlayText = overlayText.value;
  drawOverlay();
});
overlayText.addEventListener("blur", () => {
  if (isCurrentlyStreaming) overlayNeedsRestart.style.display = "";
  applyOverlaySettings();
});
overlayText.addEventListener("keydown", (e) => {
  if (e.key === "Enter") { overlayText.blur(); }
});

showTimestamp.addEventListener("change", () => {
  currentOverlayConfig.showTimestamp = showTimestamp.checked;
  updateOverlayVisibility();
  drawOverlay();
  if (!isCurrentlyStreaming) {
    const ps = document.getElementById("overlayPreviewStatus");
    if (ps) ps.style.display = "block";
  }
  applyOverlaySettings();
});

// Apply timestamp format changes when user leaves the field or presses Enter
timestampFormat.addEventListener("input", () => {
  currentOverlayConfig.timestampFormat = timestampFormat.value;
});
timestampFormat.addEventListener("blur", () => {
  if (isCurrentlyStreaming) overlayNeedsRestart.style.display = "";
  applyOverlaySettings();
});
timestampFormat.addEventListener("keydown", (e) => {
  if (e.key === "Enter") { timestampFormat.blur(); }
});

// Per-element font size changes (debounced)
let titleFontSizeTimeout;
titleFontSize.addEventListener("input", () => {
  currentOverlayConfig.titleFontSize = parseInt(titleFontSize.value);
  currentOverlayConfig.overlayFontSize = parseInt(titleFontSize.value); // sync legacy
  drawOverlay();
  clearTimeout(titleFontSizeTimeout);
  titleFontSizeTimeout = setTimeout(() => { applyOverlaySettings(); }, 500);
});

let tsFontSizeTimeout;
timestampFontSize.addEventListener("input", () => {
  currentOverlayConfig.timestampFontSize = parseInt(timestampFontSize.value);
  drawOverlay();
  clearTimeout(tsFontSizeTimeout);
  tsFontSizeTimeout = setTimeout(() => { applyOverlaySettings(); }, 500);
});

// Per-element color changes
titleColor.addEventListener("change", () => {
  currentOverlayConfig.titleColor = titleColor.value;
  currentOverlayConfig.overlayColor = titleColor.value; // sync legacy
  drawOverlay();
  applyOverlaySettings();
});
timestampColor.addEventListener("change", () => {
  currentOverlayConfig.timestampColor = timestampColor.value;
  drawOverlay();
  applyOverlaySettings();
});

// Per-element background changes
titleBackground.addEventListener("change", () => {
  currentOverlayConfig.titleBackground = titleBackground.value;
  currentOverlayConfig.overlayBackground = titleBackground.value; // sync legacy
  drawOverlay();
  applyOverlaySettings();
});
timestampBackground.addEventListener("change", () => {
  currentOverlayConfig.timestampBackground = timestampBackground.value;
  drawOverlay();
  applyOverlaySettings();
});

// Apply URL changes when user leaves the field or presses Enter
overlayUrl.addEventListener("input", () => {
  currentOverlayConfig.overlayUrl = overlayUrl.value;
  drawOverlay();
});
overlayUrl.addEventListener("blur", () => {
  if (isCurrentlyStreaming) overlayNeedsRestart.style.display = "";
  applyOverlaySettings();
});
overlayUrl.addEventListener("keydown", (e) => {
  if (e.key === "Enter") { overlayUrl.blur(); }
});

// Overlay zoom slider
overlayZoom.addEventListener("input", () => {
  overlayZoomValue.textContent = overlayZoom.value + "%";
  currentOverlayConfig.overlayZoom = parseInt(overlayZoom.value);
});
overlayZoom.addEventListener("change", () => {
  applyOverlaySettings();
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
  console.log("Overlay saved:", result);
  if (!result.success) {
    alert(`Overlay error: ${result.error}`);
  }
});

// Load overlay settings from stream status
socket.on("streamStatus", (status) => {
  if (status.config) {
    overlayEnabled.checked = status.config.overlayEnabled || false;
    overlayText.value = status.config.overlayText || "";
    showTimestamp.checked = status.config.showTimestamp || false;
    remoteOverlayEnabled.checked = status.config.remoteOverlayEnabled || false;
    overlayUrl.value = status.config.overlayUrl || "";
    overlayZoom.value = status.config.overlayZoom || 100;
    overlayZoomValue.textContent = overlayZoom.value + "%";

    // Set position dropdowns and update custom dropdown displays
    timestampPosition.value = status.config.timestampPosition || "bottom-right";
    timestampFormat.value = status.config.timestampFormat || "%Y-%m-%d %H:%M:%S";
    titlePosition.value = status.config.titlePosition || "top-left";
    updateCustomDropdownDisplay(timestampPosition);
    updateCustomDropdownDisplay(titlePosition);

    // Per-element formatting — fall back to legacy shared values if per-element not saved yet
    const savedTitleFontSize = status.config.titleFontSize || status.config.overlayFontSize || 32;
    const savedTitleColor = status.config.titleColor || status.config.overlayColor || "white";
    const savedTitleBg = status.config.titleBackground || status.config.overlayBackground || "transparent";
    const savedTsFontSize = status.config.timestampFontSize || Math.round((status.config.overlayFontSize || 32) * 0.75);
    const savedTsColor = status.config.timestampColor || status.config.overlayColor || "white";
    const savedTsBg = status.config.timestampBackground || status.config.overlayBackground || "transparent";

    titleFontSize.value = savedTitleFontSize;
    titleColor.value = savedTitleColor;
    updateCustomDropdownDisplay(titleColor);
    titleBackground.value = savedTitleBg;
    updateCustomDropdownDisplay(titleBackground);

    timestampFontSize.value = savedTsFontSize;
    timestampColor.value = savedTsColor;
    updateCustomDropdownDisplay(timestampColor);
    timestampBackground.value = savedTsBg;
    updateCustomDropdownDisplay(timestampBackground);

    // Sync hidden legacy fields
    overlayFontSize.value = savedTitleFontSize;
    overlayColor.value = savedTitleColor;
    overlayBackground.value = savedTitleBg;

    // Update visibility based on loaded state
    updateOverlayVisibility();

    // Update preview overlay
    currentOverlayConfig = {
      overlayEnabled: status.config.overlayEnabled || false,
      overlayType: status.config.overlayType || "text",
      overlayText: status.config.overlayText || "",
      showTimestamp: status.config.showTimestamp || false,
      remoteOverlayEnabled: status.config.remoteOverlayEnabled || false,
      overlayUrl: status.config.overlayUrl || "",
      timestampPosition: status.config.timestampPosition || "bottom-right",
      timestampFormat: status.config.timestampFormat || "%Y-%m-%d %H:%M:%S",
      titlePosition: status.config.titlePosition || "top-left",
      titleFontSize: savedTitleFontSize,
      titleColor: savedTitleColor,
      titleBackground: savedTitleBg,
      timestampFontSize: savedTsFontSize,
      timestampColor: savedTsColor,
      timestampBackground: savedTsBg,
      overlayFontSize: savedTitleFontSize,
      overlayColor: savedTitleColor,
      overlayBackground: savedTitleBg,
      overlayZoom: status.config.overlayZoom || 100,
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
      streamProtocol.value = data.config.protocol || "rtsp";
      streamDestination.value = data.config.destination || "";
      streamBitrate.value = data.config.bitrate || 5000000;
      audioEnabledCheckbox.checked = data.config.audioEnabled !== false; // default true

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

      // Show/hide destination field and connection info box based on protocol
      updateConnectionInfo(data.config.protocol || "rtsp", deviceLocalIP);
    }
  } catch (error) {
    console.error("❌ Error loading stream config:", error);
  }
}

// Load stream config on page load
loadStreamConfig();

// Fetch and display device IP address
async function loadDeviceIp() {
  try {
    const response = await fetch("/api/network");
    const data = await response.json();
    if (data.success && data.addresses.length > 0) {
      deviceLocalIP = data.addresses[0].address;
    }
    // Refresh connection info box with resolved IP
    updateConnectionInfo(streamProtocol.value, deviceLocalIP);
  } catch (error) {
    console.error("❌ Error loading device IP:", error);
  }
}
loadDeviceIp();

// ═══════════════════════════════════════════════════════════════
//  WiFi / Hotspot Panel
// ═══════════════════════════════════════════════════════════════

(function initWifiPanel() {

  // ── collapse / expand toggle ────────────────────────────────
  const toggle  = document.getElementById("wifiPanelToggle");
  const body    = document.getElementById("wifiPanelBody");
  const chevron = document.getElementById("wifiChevron");
  if (toggle) {
    toggle.addEventListener("click", () => {
      const open = body.style.display !== "none";
      body.style.display = open ? "none" : "block";
      chevron.textContent = open ? "▶" : "▼";
    });
  }

  // ── helper: show a temporary message ───────────────────────
  function showMsg(el, text, isError = false) {
    if (!el) return;
    el.textContent = text;
    el.style.color = isError ? "#f87171" : "#4ade80";
    setTimeout(() => { el.textContent = ""; }, 5000);
  }

  // ── load & display current WiFi / AP status ─────────────────
  async function loadWifiStatus() {
    try {
      const r = await fetch("/api/wifi/status");
      const d = await r.json();
      if (!d.success) return;

      // AP badge
      const badge = document.getElementById("apBadge");
      if (badge) {
        badge.textContent = d.apRunning ? "● Active" : "○ Inactive";
        badge.className = "ap-badge " + (d.apRunning ? "ap-badge-on" : "ap-badge-off");
      }
      setText("apSsid",     d.apSsid     || "—");
      setText("apPassword", d.apPassword || "—");

      const urlEl = document.getElementById("apAdminUrl");
      if (urlEl && d.apAdminUrl) {
        urlEl.textContent = d.apAdminUrl;
        urlEl.href = d.apAdminUrl;
      }

      setText("connectedNetwork", d.connectedNetwork || "Not connected");
    } catch (e) {
      console.warn("WiFi status fetch failed:", e.message);
    }
  }

  function setText(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  }

  // ── scan networks ───────────────────────────────────────────
  let selectedSsid = null;

  document.getElementById("scanNetworks")?.addEventListener("click", async () => {
    const btn = document.getElementById("scanNetworks");
    btn.disabled = true;
    btn.textContent = "🔍 Scanning…";
    document.getElementById("networksListWrap").style.display = "none";
    document.getElementById("connectForm").style.display = "none";
    selectedSsid = null;

    try {
      const r = await fetch("/api/wifi/networks");
      const d = await r.json();
      const list = document.getElementById("networksList");
      list.innerHTML = "";

      if (!d.success || !d.networks.length) {
        list.innerHTML = '<div class="wifi-network-item">No networks found</div>';
      } else {
        d.networks.forEach(n => {
          const div = document.createElement("div");
          div.className = "wifi-network-item" + (n.connected ? " wifi-network-active" : "");
          div.innerHTML =
            `<span class="wifi-net-ssid">${n.ssid}</span>` +
            `<span class="wifi-net-meta">${signalIcon(n.signal)} ${n.security || "open"}</span>`;
          div.addEventListener("click", () => selectNetwork(n.ssid));
          list.appendChild(div);
        });
      }
      document.getElementById("networksListWrap").style.display = "block";
    } catch (e) {
      console.error("Scan failed:", e);
    } finally {
      btn.disabled = false;
      btn.textContent = "🔍 Scan Networks";
    }
  });

  function signalIcon(sig) {
    if (sig >= 75) return "▮▮▮▮";
    if (sig >= 50) return "▮▮▮░";
    if (sig >= 25) return "▮▮░░";
    return "▮░░░";
  }

  function selectNetwork(ssid) {
    selectedSsid = ssid;
    setText("connectTargetSsid", ssid);
    document.getElementById("connectPassword").value = "";
    document.getElementById("connectMsg").textContent = "";
    document.getElementById("connectForm").style.display = "block";
    document.getElementById("connectPassword").focus();
  }

  document.getElementById("cancelConnect")?.addEventListener("click", () => {
    document.getElementById("connectForm").style.display = "none";
    selectedSsid = null;
  });

  // ── connect to network ──────────────────────────────────────
  document.getElementById("doConnect")?.addEventListener("click", async () => {
    if (!selectedSsid) return;
    const pw  = document.getElementById("connectPassword").value;
    const btn = document.getElementById("doConnect");
    const msg = document.getElementById("connectMsg");
    btn.disabled = true;
    btn.textContent = "Connecting…";
    try {
      const r = await fetch("/api/wifi/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ssid: selectedSsid, password: pw }),
      });
      const d = await r.json();
      if (d.success) {
        showMsg(msg, `✅ Connected to ${selectedSsid}`);
        document.getElementById("connectForm").style.display = "none";
        setTimeout(loadWifiStatus, 3000);
      } else {
        showMsg(msg, `❌ ${d.error || "Connection failed"}`, true);
      }
    } catch (e) {
      showMsg(msg, `❌ ${e.message}`, true);
    } finally {
      btn.disabled = false;
      btn.textContent = "✅ Connect";
    }
  });

  // ── disconnect ──────────────────────────────────────────────
  document.getElementById("disconnectWifi")?.addEventListener("click", async () => {
    await fetch("/api/wifi/disconnect", { method: "POST" });
    setTimeout(loadWifiStatus, 2000);
  });

  // ── save AP config ──────────────────────────────────────────
  document.getElementById("saveApConfig")?.addEventListener("click", async () => {
    const ssid = document.getElementById("newApSsid").value.trim();
    const pw   = document.getElementById("newApPassword").value.trim();
    const msg  = document.getElementById("apConfigMsg");
    if (!ssid && !pw) { showMsg(msg, "Enter a new SSID and/or password", true); return; }
    if (pw && pw.length < 8) { showMsg(msg, "Password must be at least 8 characters", true); return; }

    const btn = document.getElementById("saveApConfig");
    btn.disabled = true;
    btn.textContent = "Saving…";
    try {
      const r = await fetch("/api/wifi/ap/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ssid: ssid || undefined, password: pw || undefined }),
      });
      const d = await r.json();
      if (d.success) {
        showMsg(msg, "✅ Hotspot updated — reconnect using the new SSID");
        loadWifiStatus();
      } else {
        showMsg(msg, `❌ ${d.error}`, true);
      }
    } catch (e) {
      showMsg(msg, `❌ ${e.message}`, true);
    } finally {
      btn.disabled = false;
      btn.textContent = "💾 Save & Restart Hotspot";
    }
  });

  // ── kick off ────────────────────────────────────────────────
  loadWifiStatus();
  // Refresh status every 30 s
  setInterval(loadWifiStatus, 30_000);

})();
