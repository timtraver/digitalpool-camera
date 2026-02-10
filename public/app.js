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
