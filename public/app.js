console.log("=".repeat(60));
console.log("🎬 DIGITALPOOL CAMERA APP.JS STARTING");
console.log("=".repeat(60));

// ── Device registration state ─────────────────────────────────────────────────
// Set to true once /api/setup/status confirms the device is registered.
// The stream start button is kept disabled until this is true.
let deviceRegistered = false;

// ── Global 401 interceptor ────────────────────────────────────────────────────
// Wraps window.fetch so that ANY API response with HTTP 401 (session expired /
// server restarted) immediately redirects to the login page instead of leaving
// the user staring at a UI that looks active but is actually unauthenticated.
(function installAuthInterceptor() {
  const _fetch = window.fetch.bind(window);
  window.fetch = async function (...args) {
    const res = await _fetch(...args);
    if (res.status === 401) {
      // Avoid redirect loops on the login page itself
      if (!window.location.pathname.startsWith("/login")) {
        console.warn("🔒 Session expired — redirecting to login");
        window.location.href = "/login";
      }
    }
    return res;
  };
})();

// Custom Dropdown Helper Function
function createCustomDropdown(selectElement) {
  const options = Array.from(selectElement.options).map((opt) => ({
    value: opt.value,
    text: opt.text,
    html: opt.dataset.html || null, // optional rich HTML label (e.g. SVG logo)
    selected: opt.selected,
  }));

  const selectedOption = options.find((opt) => opt.selected) || options[0];

  // Create custom dropdown structure
  const container = document.createElement("div");
  container.className = "custom-dropdown";

  const selected = document.createElement("div");
  selected.className = "custom-dropdown-selected";
  // Use innerHTML when a rich label is supplied, otherwise plain text
  if (selectedOption.html) { selected.innerHTML = selectedOption.html; }
  else { selected.textContent = selectedOption.text; }
  selected.dataset.value = selectedOption.value;

  const optionsContainer = document.createElement("div");
  optionsContainer.className = "custom-dropdown-options";

  options.forEach((opt) => {
    const optionDiv = document.createElement("div");
    optionDiv.className = "custom-dropdown-option";
    if (opt.value === selectedOption.value) {
      optionDiv.classList.add("selected");
    }
    if (opt.html) { optionDiv.innerHTML = opt.html; }
    else { optionDiv.textContent = opt.text; }
    optionDiv.dataset.value = opt.value;

    optionDiv.addEventListener("click", () => {
      // Update selected display
      if (opt.html) { selected.innerHTML = opt.html; }
      else { selected.textContent = opt.text; }
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
      if (selectedOption.dataset.html) { customDropdown.innerHTML = selectedOption.dataset.html; }
      else { customDropdown.textContent = selectedOption.text; }
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

// ── Active camera index ─────────────────────────────────────────────────────
// 1 = Camera 1 (default), 2 = Camera 2.  All socket emits and API calls
// include `cameraIndex: activeCamIndex` so the server routes to the right
// controller instance.
let activeCamIndex = 1;

/** Switch the UI to the given camera index (1 or 2). */
function switchCamera(newIdx) {
  if (newIdx === activeCamIndex) return;
  activeCamIndex = newIdx;
  console.log(`📷 Switching to Camera ${activeCamIndex}`);

  // Update tab bar active state
  document.querySelectorAll(".camera-tab").forEach((tab) => {
    tab.classList.toggle("active", parseInt(tab.dataset.cam) === activeCamIndex);
  });

  // Re-request configs for the newly-selected camera
  socket.emit("getCameraConfig",      { cameraIndex: activeCamIndex });
  socket.emit("getStartupPosition",   { cameraIndex: activeCamIndex });
  socket.emit("getStreamStatus",      { cameraIndex: activeCamIndex });

  // Reload camera input panel (source type, USB device, RTSP URL, NDI name)
  // for the new camera — reloadCameraInput is assigned by initCameraInput IIFE.
  if (reloadCameraInput) reloadCameraInput();

  // Reload stream settings (protocol, bitrate, resolution, audio, flip, etc.)
  // from the server for the new camera. loadStreamConfig() reads activeCamIndex
  // so it must be called after the assignment above.
  //
  // If the audio device list was already loaded (user previously clicked 🔄),
  // reload it for the new camera so the correct per-camera device is selected
  // automatically — the user should never have to click 🔄 again just because
  // they switched tabs.
  loadStreamConfig().then(() => {
    if (_audioDevicesLoaded) loadAudioDevices();
  });

  // Refresh the connection info box for the correct camera's paths/ports
  // (loadStreamConfig also calls this after the fetch, but update immediately
  // so the URL box doesn't lag behind while the request is in-flight)
  updateConnectionInfo(streamProtocol.value, deviceLocalIP);

  // Refresh the idle preview to the correct camera
  const videoStream = document.getElementById("videoStream");
  if (videoStream) {
    videoStream.src = `/video/stream?cam=${activeCamIndex}&t=${Date.now()}`;
  }
  // Switch WebRTC preview path if one is active
  switchToWebRTCPreview(`preview${activeCamIndex === 2 ? "2" : ""}`);
}

// Wire up tab buttons
document.querySelectorAll(".camera-tab").forEach((tab) => {
  tab.addEventListener("click", () => switchCamera(parseInt(tab.dataset.cam)));
});

// Update live-stream dot in tab when stream status changes for that camera
function updateCameraTabStatus(camIdx, isLive) {
  const dot = document.getElementById(`camTabStatus${camIdx}`);
  if (dot) dot.classList.toggle("live", isLive);
}

// Connection status
const statusElement = document.getElementById("connectionStatus");

socket.on("connect", () => {
  statusElement.textContent = "Connected";
  statusElement.className = "status status-connected";
  console.log("Connected to server");

  // Request camera configuration on connect
  socket.emit("getCameraConfig",    { cameraIndex: activeCamIndex });
  socket.emit("getStartupPosition", { cameraIndex: activeCamIndex });
});

socket.on("disconnect", () => {
  statusElement.textContent = "Disconnected";
  statusElement.className = "status status-disconnected";
  console.log("Disconnected from server");
});

socket.on("controlResult", (result) => {
  console.log("Control result:", result);
  if (!result.success) {
    console.error(`❌ Control error [${result.control}]:`, result.error);
    // Show a brief visible error so failures aren't silent
    showControlError(result.control, result.error);
  }
});

function showControlError(control, message) {
  let toast = document.getElementById("controlErrorToast");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "controlErrorToast";
    toast.style.cssText =
      "position:fixed;bottom:1rem;left:50%;transform:translateX(-50%);" +
      "background:#b91c1c;color:#fff;padding:0.5rem 1.2rem;border-radius:6px;" +
      "font-size:0.85rem;z-index:9999;max-width:90vw;text-align:center;" +
      "box-shadow:0 2px 8px rgba(0,0,0,0.4);";
    document.body.appendChild(toast);
  }
  toast.textContent = `⚠️ ${control}: ${message || "command failed"}`;
  toast.style.display = "block";
  clearTimeout(toast._hideTimer);
  toast._hideTimer = setTimeout(() => {
    toast.style.display = "none";
  }, 4000);
}

// Handle camera configuration from server
socket.on("cameraConfig", (data) => {
  // Ignore updates for the non-active camera
  if (data.cameraIndex && data.cameraIndex !== activeCamIndex) return;
  if (data.success && data.config) {
    console.log(`📸 [Cam${data.cameraIndex || 1}] Received camera configuration:`, data.config);
    loadCameraConfigToUI(data.config);

    // Dim controls that the attached camera doesn't support.
    if (data.supportedControls) {
      applyControlAvailability(data.supportedControls);
    }

    // Update PTZ hardware state for percentage/step calculations.
    // ptzRanges: { pan_absolute: {min, max, step}, tilt_absolute: {min, max, step} }
    // All values are raw hardware units — no degree conversion needed.
    if (data.ptzRanges) {
      if (data.ptzRanges.pan_absolute) {
        const { min, max, step } = data.ptzRanges.pan_absolute;
        _panHwStep  = step || 3600;
        _panHwRange = max - min;
      }
      if (data.ptzRanges.tilt_absolute) {
        const { min, max, step } = data.ptzRanges.tilt_absolute;
        _tiltHwStep  = step || 3600;
        _tiltHwRange = max - min;
      }
      console.log(
        `📐 PTZ hw state updated — ` +
        `pan: range=${_panHwRange} units, step=${_panHwStep} units, large=${panLargeSteps()} steps | ` +
        `tilt: range=${_tiltHwRange} units, step=${_tiltHwStep} units, large=${tiltLargeSteps()} steps`
      );
    }
  }
});

// Handle camera reset response
socket.on("cameraConfigReset", (data) => {
  // Ignore broadcasts for the non-active camera so multi-tab/multi-client
  // sessions don't get cross-talk.
  if (data.cameraIndex && data.cameraIndex !== activeCamIndex) return;
  if (data.success && data.config) {
    console.log(`🔄 [Cam${data.cameraIndex || 1}] Reset to defaults — capabilities re-read`);
    loadCameraConfigToUI(data.config);
    // Re-apply availability with the freshly-discovered hardware controls so
    // newly-supported rows un-dim and unsupported rows dim, all in one pass.
    if (data.supportedControls) {
      applyControlAvailability(data.supportedControls);
    }
    // Clear the startup/home position display since it was also reset
    const startupPosInfo = document.getElementById("startupPosInfo");
    if (startupPosInfo) {
      startupPosInfo.textContent = "No home position set";
    }
    alert("All camera settings have been reset to defaults!");
  }
});

// ── Pan/Tilt/Zoom Controls ────────────────────────────────────────────────────
//
// All movement is expressed in RAW HARDWARE STEPS — the integer multiple of the
// camera's minimum step unit — so nothing is lost to degree conversion rounding.
//
//   Inner ring / Arrow key      → 1 step up to PTZ_ACCEL_PCT % of full travel
//   Outer ring / Shift+Arrow    → PTZ_LARGE_PCT % of the full travel, in steps
//
// The server's pan(steps) and tilt(steps) methods multiply by hwCtrl.step to
// get the actual hardware unit delta, then clamp to [min, max].
const PTZ_LARGE_PCT = 5; // % of full travel per outer-ring / Shift+arrow press
const PTZ_ACCEL_PCT = 1; // % of full travel — acceleration ceiling for inner-ring / Arrow key

// Live hardware state — updated from ptzRanges in the cameraConfig socket event.
// Defaults are for the OBSBot Tiny 2 Lite: step=3600 units, range ±468000/±324000.
let _panHwStep   = 3600;   // minimum hardware units per pan step
let _tiltHwStep  = 3600;   // minimum hardware units per tilt step
let _panHwRange  = 936000; // total pan travel in hardware units (max − min)
let _tiltHwRange = 648000; // total tilt travel in hardware units (max − min)

/** Steps for the inner ring (always 1 — the hardware minimum). */
const panSmallSteps  = () => 1;
const tiltSmallSteps = () => 1;

/** Steps for the outer ring (PTZ_LARGE_PCT of full travel, minimum 1). */
const panLargeSteps  = () => Math.max(1, Math.round(_panHwRange  * PTZ_LARGE_PCT / 100 / _panHwStep));
const tiltLargeSteps = () => Math.max(1, Math.round(_tiltHwRange * PTZ_LARGE_PCT / 100 / _tiltHwStep));

/** Acceleration ceiling for the inner ring / Arrow key (PTZ_ACCEL_PCT of full travel, minimum 1).
 *  Inner-ring hold ramps from 1 hw step up to this cap — never reaching outer-ring speed. */
const panAccelSteps  = () => Math.max(1, Math.round(_panHwRange  * PTZ_ACCEL_PCT / 100 / _panHwStep));
const tiltAccelSteps = () => Math.max(1, Math.round(_tiltHwRange * PTZ_ACCEL_PCT / 100 / _tiltHwStep));

// ── Hold-to-repeat + acceleration ────────────────────────────────────────────
// After PTZ_REPEAT_DELAY ms, commands fire every PTZ_REPEAT_INTERVAL ms.
// For inner-ring buttons the step count grows exponentially with each tick,
// from 1 hardware step up to the outer-ring step count over PTZ_RAMP_TICKS ticks.
const PTZ_REPEAT_DELAY    = 400; // ms before repeat kicks in
const PTZ_REPEAT_INTERVAL = 200; // ms between repeat commands while held
const PTZ_RAMP_TICKS      = 15;  // ticks to reach full outer-ring speed (~3 s)

// Shared repeat-timer state — only one button active at a time.
let _ptzDelayTimer  = null;
let _ptzRepeatTimer = null;

function _clearPTZTimers() {
  if (_ptzDelayTimer)  { clearTimeout(_ptzDelayTimer);   _ptzDelayTimer  = null; }
  if (_ptzRepeatTimer) { clearInterval(_ptzRepeatTimer); _ptzRepeatTimer = null; }
}

/**
 * Compute an exponentially accelerated step count.
 *
 * Uses the curve  steps = round( maxSteps ^ (tick / PTZ_RAMP_TICKS) )
 * which gives:
 *   tick  0  →  1 step          (first press, maximum precision)
 *   tick  N/2 →  √maxSteps      (halfway)
 *   tick  N  →  maxSteps steps  (full outer-ring speed)
 *
 * @param {number} tick      How many fire() calls have happened so far (0-based)
 * @param {number} maxSteps  The ceiling — same value as the outer-ring button
 * @returns {number}         Positive step count (≥ 1)
 */
function ptzAccelSteps(tick, maxSteps) {
  if (maxSteps <= 1 || tick === 0) return 1;
  const factor = Math.min(1, tick / PTZ_RAMP_TICKS);
  return Math.max(1, Math.round(Math.pow(maxSteps, factor)));
}

/**
 * Wire a PTZ button with immediate-fire, hold-to-repeat, and optional
 * exponential acceleration on hold.
 *
 * @param {string}         id          Element id
 * @param {string}         evt         Socket event ('pan' or 'tilt')
 * @param {()=>number}     getSteps    Getter for base step count (signed).
 *                                     For inner ring this is always ±1.
 * @param {string}         label       Log label
 * @param {()=>number|null} getMaxSteps Optional getter for the acceleration ceiling
 *                                     (the outer-ring step count for this axis).
 *                                     Pass null / omit for outer ring (no ramp).
 */
function makePTZButton(id, evt, getSteps, label, getMaxSteps = null) {
  const el = document.getElementById(id);
  if (!el) return;

  let _tick = 0;

  function currentSteps() {
    if (!getMaxSteps) return getSteps(); // outer ring: always constant
    const sign = getSteps() < 0 ? -1 : 1;
    // Math.abs — getMaxSteps() may be negative for right/down buttons;
    // the sign is already applied above, so the ceiling must be positive.
    return sign * ptzAccelSteps(_tick, Math.abs(getMaxSteps()));
  }

  function fire() {
    const steps = currentSteps();
    console.log(`${label}: ${steps} step(s) [tick=${_tick}]`);
    socket.emit(evt, { steps, cameraIndex: activeCamIndex });
    _tick++;
  }

  function startRepeat() {
    _clearPTZTimers();
    _tick = 0;
    fire(); // immediate first step on press
    _ptzDelayTimer = setTimeout(() => {
      _ptzRepeatTimer = setInterval(fire, PTZ_REPEAT_INTERVAL);
    }, PTZ_REPEAT_DELAY);
  }

  function stopRepeat() {
    _clearPTZTimers();
    _tick = 0;
  }

  // Mouse — preventDefault stops text-selection drag from leaving button stuck
  el.addEventListener("mousedown",   (e) => { e.preventDefault(); startRepeat(); });
  el.addEventListener("mouseup",     stopRepeat);
  el.addEventListener("mouseleave",  stopRepeat);
  el.addEventListener("contextmenu", stopRepeat);

  // Touch (mobile / tablet)
  el.addEventListener("touchstart",  (e) => { e.preventDefault(); startRepeat(); }, { passive: false });
  el.addEventListener("touchend",    stopRepeat);
  el.addEventListener("touchcancel", stopRepeat);
}

// Inner ring — starts at 1 hw step, accelerates to PTZ_ACCEL_PCT (1%) of full travel on hold
makePTZButton("panLeftSmall",  "pan",  () =>  1,  "🔵 Pan Left",  () =>  panAccelSteps());
makePTZButton("panRightSmall", "pan",  () => -1,  "🔵 Pan Right", () => -panAccelSteps());
makePTZButton("tiltUpSmall",   "tilt", () =>  1,  "🔵 Tilt Up",   () =>  tiltAccelSteps());
makePTZButton("tiltDownSmall", "tilt", () => -1,  "🔵 Tilt Down", () => -tiltAccelSteps());

// Outer ring — constant PTZ_LARGE_PCT % of full travel (no acceleration)
makePTZButton("panLeftLarge",  "pan",  () =>  panLargeSteps(),  "🔷 Pan Left (large)");
makePTZButton("panRightLarge", "pan",  () => -panLargeSteps(),  "🔷 Pan Right (large)");
makePTZButton("tiltUpLarge",   "tilt", () =>  tiltLargeSteps(), "🔷 Tilt Up (large)");
makePTZButton("tiltDownLarge", "tilt", () => -tiltLargeSteps(), "🔷 Tilt Down (large)");

// Center reset button
document.getElementById("resetPos").addEventListener("click", () => {
  socket.emit("resetPosition", { cameraIndex: activeCamIndex });
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
    socket.emit("zoom", { level: value, cameraIndex: activeCamIndex });
  });
}

// Startup position controls
const setStartupBtn = document.getElementById("setStartupPosition");
const startupPosInfo = document.getElementById("startupPosInfo");

if (setStartupBtn) {
  setStartupBtn.addEventListener("click", () => {
    socket.emit("setStartupPosition", { cameraIndex: activeCamIndex });
  });
}

socket.on("startupPositionSet", (data) => {
  if (data.success) {
    const pos = data.position;
    if (startupPosInfo) {
      startupPosInfo.textContent = `Home: pan=${pos.pan_absolute}, tilt=${pos.tilt_absolute}, zoom=${pos.zoom_absolute}`;
    }
    console.log("📌 Home position saved:", pos);
  }
});

socket.on("startupPosition", (data) => {
  if (data.position && startupPosInfo) {
    const pos = data.position;
    startupPosInfo.textContent = `Home: pan=${pos.pan_absolute}, tilt=${pos.tilt_absolute}, zoom=${pos.zoom_absolute}`;
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
    socket.emit("setControl", { control: controlName, value: value, cameraIndex: activeCamIndex });
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
    socket.emit("setControl", { control: "auto_exposure", value: value, cameraIndex: activeCamIndex });
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
      cameraIndex: activeCamIndex,
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
    socket.emit("setControl", { control: "focus_automatic_continuous", value: value, cameraIndex: activeCamIndex });
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

/**
 * Dim (and disable) any camera control rows whose v4l2 control is not
 * supported by the currently-attached camera, and un-dim controls that ARE
 * supported.  Symmetric so it can be safely re-run after a camera swap or
 * a manual capability re-read (Reset All) without leaving stale state.
 *
 * @param {string[]} supportedControls - Array of v4l2 control names reported
 *   by the server from camera.discoveredControls.  When empty/missing the
 *   function is a no-op so the UI stays fully functional.
 */
function applyControlAvailability(supportedControls) {
  if (!supportedControls || supportedControls.length === 0) return;
  const supported = new Set(supportedControls);

  // Map each v4l2 control name to the HTML element id that represents it.
  // PTZ directional buttons are handled separately below.
  const CONTROL_MAP = {
    brightness:                 "brightness",
    contrast:                   "contrast",
    saturation:                 "saturation",
    hue:                        "hue",
    sharpness:                  "sharpness",
    gamma:                      "gamma",
    auto_exposure:              "exposureAuto",
    exposure_time_absolute:     "exposureAbsolute",
    gain:                       "gain",
    backlight_compensation:     "backlightCompensation",
    white_balance_automatic:    "whiteBalanceAuto",
    white_balance_temperature:  "whiteBalanceTemp",
    focus_automatic_continuous: "focusAuto",
    focus_absolute:             "focusAbsolute",
    zoom_absolute:              "zoomLevel",
  };

  for (const [controlName, elementId] of Object.entries(CONTROL_MAP)) {
    const el = document.getElementById(elementId);
    if (!el) continue;
    const row = el.closest(".control-item");
    if (!row) continue;
    if (supported.has(controlName)) {
      // Re-enable a previously-dimmed row in case the camera was swapped or
      // capabilities were re-read.
      row.style.opacity = "";
      row.style.pointerEvents = "";
      row.title = "";
      el.disabled = false;
    } else {
      // Dim the entire row so label, input, and value display fade together.
      row.style.opacity = "0.35";
      row.style.pointerEvents = "none";
      row.title = "Not supported by this camera";
      el.disabled = true;
    }
  }

  // Dim the directional pad and Set-Home button when pan/tilt aren't available.
  const hasPan  = supported.has("pan_absolute");
  const hasTilt = supported.has("tilt_absolute");
  const padContainer = document.querySelector(".directional-pad-container");
  const homeBtn = document.getElementById("setStartupPosition");
  if (!hasPan && !hasTilt) {
    if (padContainer) {
      padContainer.style.opacity = "0.35";
      padContainer.style.pointerEvents = "none";
      padContainer.title = "Pan/tilt not supported by this camera";
    }
    if (homeBtn) { homeBtn.disabled = true; homeBtn.style.opacity = "0.35"; }
  } else {
    if (padContainer) {
      padContainer.style.opacity = "";
      padContainer.style.pointerEvents = "";
      padContainer.title = "";
    }
    if (homeBtn) { homeBtn.disabled = false; homeBtn.style.opacity = ""; }
  }

  // After individual rows are updated, refresh each collapsible section's
  // "(not supported)" badge based on current state.
  document.querySelectorAll("details.cam-subsection").forEach((section) => {
    const inputs = Array.from(section.querySelectorAll("input, select"));
    const titleEl = section.querySelector(".cam-subsection-title");
    if (!titleEl) return;
    const existingBadge = titleEl.querySelector(".unsupported-badge");
    const allDisabled = inputs.length > 0 && inputs.every((inp) => inp.disabled);
    if (allDisabled) {
      if (!existingBadge) {
        const badge = document.createElement("span");
        badge.className = "unsupported-badge";
        badge.style.cssText = "font-size:10px;opacity:0.55;margin-left:8px;font-style:italic;font-weight:normal;";
        badge.textContent = "(not supported)";
        titleEl.appendChild(badge);
      }
      section.style.opacity = "0.5";
    } else {
      if (existingBadge) existingBadge.remove();
      section.style.opacity = "";
    }
  });

  console.log(`🎛️  Control availability applied — ${supportedControls.length} controls supported by this camera`);
}

// Reset all settings
const resetAllBtn = document.getElementById("resetAll");
if (resetAllBtn) {
  resetAllBtn.addEventListener("click", async () => {
    if (confirm("Reset all camera settings to defaults?")) {
      // Send reset command to server
      socket.emit("resetCameraSettings", { cameraIndex: activeCamIndex });
    }
  });
}

// Declared here (before initCameraInput IIFE) so the IIFE can reference them
// without hitting the const Temporal Dead Zone.
const audioEnabledCheckbox   = document.getElementById("audioEnabled");
const audioSourceRow         = document.getElementById("audioSourceRow");
const audioSourceTypeSelect  = document.getElementById("audioSourceType");
const audioDeviceRow         = document.getElementById("audioDeviceRow");
const audioDeviceSelect      = document.getElementById("audioDeviceSelect");
const refreshAudioDevicesBtn = document.getElementById("refreshAudioDevices");
const audioOffsetRow         = document.getElementById("audioOffsetRow");
const audioOffsetInput       = document.getElementById("audioOffset");

// True once the user has clicked 🔄 at least once (audio device list was fetched).
// Used by switchCamera() to auto-refresh the device list on tab switch so the
// correct per-camera device is pre-selected without the user having to click 🔄 again.
let _audioDevicesLoaded = false;

// Video orientation flip checkboxes
const flipHorizontalCheckbox = document.getElementById("flipHorizontal");
const flipVerticalCheckbox   = document.getElementById("flipVertical");
const panInvertedCheckbox    = document.getElementById("panInverted");

// Exposed by the initCameraInput IIFE so switchCamera() can re-load device
// list and current source for the newly-selected camera.
let reloadCameraInput = null;

// ── Camera Input section ──────────────────────────────────────────────────────
(function initCameraInput() {
  const sourceTypeEl    = document.getElementById("cameraSourceType");
  const usbSection      = document.getElementById("cameraInputUsb");
  const rtspSection     = document.getElementById("cameraInputRtsp");
  const rtmpSection     = document.getElementById("cameraInputRtmp");
  const ndiSection      = document.getElementById("cameraInputNdi");
  const deviceSelect    = document.getElementById("cameraUsbDevice");
  const refreshBtn      = document.getElementById("refreshCameraDevices");
  const rtspUrlEl       = document.getElementById("cameraRtspUrl");
  const rtmpUrlEl       = document.getElementById("cameraRtmpUrl");
  const ndiNameEl       = document.getElementById("cameraNdiName");
  const ndiSearchBtn    = document.getElementById("ndiSearchBtn");
  const ndiSourceList   = document.getElementById("ndiSourceList");
  const ndiSourceSelect = document.getElementById("ndiSourceSelect");
  const ndiSearchStatus = document.getElementById("ndiSearchStatus");
  const applyBtn        = document.getElementById("applyCameraInput");
  const statusEl        = document.getElementById("cameraInputStatus");

  if (!sourceTypeEl) return;

  // Tracks what the server considers the active source so we can dim the button
  // when the UI selection already matches it.
  let activeSource = { type: "usb", device: "", rtspUrl: "", rtmpUrl: "", ndiName: "" };

  function updateApplyButton() {
    if (!applyBtn) return;
    const type = sourceTypeEl.value;
    let matches = type === activeSource.type;
    if (matches) {
      if (type === "usb")  matches = (deviceSelect?.value || "") === activeSource.device;
      if (type === "rtsp") matches = (rtspUrlEl?.value.trim() || "") === (activeSource.rtspUrl || "");
      if (type === "rtmp") matches = (rtmpUrlEl?.value.trim() || "") === (activeSource.rtmpUrl || "");
      if (type === "ndi")  matches = (ndiNameEl?.value.trim() || "") === (activeSource.ndiName || "");
    }
    applyBtn.disabled = matches;
  }

  async function loadDevices() {
    if (deviceSelect) deviceSelect.innerHTML = "<option>Scanning…</option>";
    try {
      const r = await fetch(`/api/camera/devices?cam=${activeCamIndex}`);
      const data = await r.json();
      if (!deviceSelect) return;
      deviceSelect.innerHTML = "";
      if (!data.devices || data.devices.length === 0) {
        deviceSelect.innerHTML = "<option value=''>No devices found</option>";
        return;
      }
      // Deduplicate: prefer the first /dev/videoN entry per camera name
      const seen = new Set();
      data.devices.forEach(({ device, name }) => {
        if (seen.has(name)) return;
        seen.add(name);
        const opt = document.createElement("option");
        opt.value = device;
        opt.textContent = `${name} (${device})`;
        deviceSelect.appendChild(opt);
      });
      // Pre-select the current active device and record it as activeSource
      if (data.current?.type === "usb" && data.current.device) {
        deviceSelect.value = data.current.device;
        activeSource = { type: "usb", device: data.current.device, rtspUrl: "", ndiName: "" };
      }
      // Pre-fill RTSP URL if currently active
      if (data.current?.type === "rtsp" && rtspUrlEl) {
        rtspUrlEl.value = data.current.rtspUrl || "";
        sourceTypeEl.value = "rtsp";
        usbSection.style.display  = "none";
        rtspSection.style.display = "";
        if (rtmpSection) rtmpSection.style.display = "none";
        if (ndiSection) ndiSection.style.display = "none";
        activeSource = { type: "rtsp", device: "", rtspUrl: data.current.rtspUrl || "", rtmpUrl: "", ndiName: "" };
      }
      // Pre-fill RTMP URL if currently active
      if (data.current?.type === "rtmp" && rtmpUrlEl) {
        rtmpUrlEl.value = data.current.rtmpUrl || "";
        sourceTypeEl.value = "rtmp";
        usbSection.style.display  = "none";
        rtspSection.style.display = "none";
        if (rtmpSection) rtmpSection.style.display = "";
        if (ndiSection) ndiSection.style.display = "none";
        activeSource = { type: "rtmp", device: "", rtspUrl: "", rtmpUrl: data.current.rtmpUrl || "", ndiName: "" };
      }
      // Pre-fill NDI source name if currently active
      if (data.current?.type === "ndi" && ndiNameEl) {
        ndiNameEl.value = data.current.ndiName || "";
        sourceTypeEl.value = "ndi";
        usbSection.style.display  = "none";
        rtspSection.style.display = "none";
        if (rtmpSection) rtmpSection.style.display = "none";
        if (ndiSection) ndiSection.style.display = "";
        activeSource = { type: "ndi", device: "", rtspUrl: "", rtmpUrl: "", ndiName: data.current.ndiName || "" };
      }
    } catch (e) {
      if (deviceSelect) deviceSelect.innerHTML = "<option value=''>Error loading devices</option>";
    }
    updateApplyButton();
    applyCameraSourceUI(activeSource.type);
  }

  // Hide camera-only controls (image quality / exposure / WB / focus, the Reset
  // All button, and the entire PTZ card) when the active source isn't USB.
  // Driven by the *applied* source, not the dropdown selection.
  function applyCameraSourceUI(type) {
    const isUsb = type === "usb";
    const camBody = document.getElementById("cameraSettingsBody");
    if (camBody) {
      const inputSection = document.getElementById("cameraSourceType")?.closest(".cam-subsection");
      camBody.querySelectorAll(".cam-subsection").forEach((sub) => {
        if (sub === inputSection) return;
        sub.style.display = isUsb ? "" : "none";
      });
      const resetBtn = document.getElementById("resetAll");
      if (resetBtn) resetBtn.style.display = isUsb ? "" : "none";
    }
    // PTZ stays visible but is greyed out + non-interactive when source isn't USB.
    const ptzToggle = document.getElementById("ptzToggle");
    const ptzBody   = document.getElementById("ptzBody");
    if (ptzToggle) ptzToggle.style.opacity = isUsb ? "" : "0.5";
    if (ptzBody) {
      ptzBody.style.opacity       = isUsb ? "" : "0.4";
      ptzBody.style.pointerEvents = isUsb ? "" : "none";
    }
  }

  // Toggle USB / RTSP / RTMP / NDI panels on source type change, and update audio device row.
  sourceTypeEl.addEventListener("change", () => {
    const type = sourceTypeEl.value;
    usbSection.style.display                 = type === "usb"  ? "" : "none";
    rtspSection.style.display                = type === "rtsp" ? "" : "none";
    if (rtmpSection) rtmpSection.style.display = type === "rtmp" ? "" : "none";
    if (ndiSection)  ndiSection.style.display  = type === "ndi"  ? "" : "none";
    updateAudioDeviceRowVisibility();
    updateApplyButton();
  });

  if (deviceSelect) deviceSelect.addEventListener("change", updateApplyButton);
  if (rtspUrlEl)    rtspUrlEl.addEventListener("input",  updateApplyButton);
  if (rtmpUrlEl)    rtmpUrlEl.addEventListener("input",  updateApplyButton);
  if (ndiNameEl)    ndiNameEl.addEventListener("input",  updateApplyButton);

  if (refreshBtn) refreshBtn.addEventListener("click", loadDevices);
  if (refreshAudioDevicesBtn) refreshAudioDevicesBtn.addEventListener("click", () => loadAudioDevices());
  if (audioEnabledCheckbox) audioEnabledCheckbox.addEventListener("change", updateAudioDeviceRowVisibility);
  if (audioSourceTypeSelect) audioSourceTypeSelect.addEventListener("change", updateAudioDeviceRowVisibility);

  // ── NDI source discovery ───────────────────────────────────────────────────
  // Clicking 🔍 calls /api/ndi/sources, waits up to 5 s for the SDK to find
  // any sources on the network, then shows a dropdown so the user can pick one.
  // Selecting from the dropdown auto-fills the text input and enables Apply.
  if (ndiSearchBtn) {
    ndiSearchBtn.addEventListener("click", async () => {
      ndiSearchBtn.disabled  = true;
      ndiSearchBtn.textContent = "⏳";
      if (ndiSearchStatus) {
        ndiSearchStatus.style.color = "rgba(255,255,255,0.55)";
        ndiSearchStatus.textContent = "🔍 Searching for NDI sources… (up to 5 s)";
      }
      if (ndiSourceList)   ndiSourceList.style.display = "none";
      if (ndiSourceSelect) ndiSourceSelect.innerHTML   = '<option value="">— select a discovered source —</option>';

      try {
        const r    = await fetch("/api/ndi/sources?timeout=5000");
        const data = await r.json();

        if (!data.success || !data.sources || data.sources.length === 0) {
          if (ndiSearchStatus) {
            ndiSearchStatus.style.color = "rgba(255,160,80,0.9)";
            ndiSearchStatus.textContent = data.error
              ? `⚠️ Discovery error: ${data.error}`
              : "⚠️ No NDI sources found. Make sure your NDI source is active on the same network.";
          }
        } else {
          // Populate the dropdown
          data.sources.forEach(({ name, url }) => {
            const opt = document.createElement("option");
            opt.value       = name;
            opt.textContent = url ? `${name}  [${url}]` : name;
            ndiSourceSelect.appendChild(opt);
          });
          if (ndiSourceList) ndiSourceList.style.display = "";
          if (ndiSearchStatus) {
            ndiSearchStatus.style.color = "rgba(80,220,120,0.9)";
            ndiSearchStatus.textContent = `✅ Found ${data.sources.length} source${data.sources.length === 1 ? "" : "s"} — select one below or type a name above.`;
          }
        }
      } catch (e) {
        if (ndiSearchStatus) {
          ndiSearchStatus.style.color = "rgba(255,160,80,0.9)";
          ndiSearchStatus.textContent = "⚠️ Network error during NDI discovery.";
        }
      } finally {
        ndiSearchBtn.disabled    = false;
        ndiSearchBtn.textContent = "🔍";
      }
    });
  }

  // Selecting a discovered source auto-fills the name input and enables Apply.
  if (ndiSourceSelect) {
    ndiSourceSelect.addEventListener("change", () => {
      const chosen = ndiSourceSelect.value;
      if (chosen && ndiNameEl) {
        ndiNameEl.value = chosen;
        updateApplyButton();
      }
    });
  }

  if (applyBtn) {
    applyBtn.addEventListener("click", async () => {
      const type = sourceTypeEl.value;
      const body = { type };
      if (type === "usb") {
        body.device = deviceSelect?.value || "";
        if (!body.device) { statusEl.textContent = "⚠️ Select a device first."; return; }
      } else if (type === "rtsp") {
        body.rtspUrl = rtspUrlEl?.value.trim() || "";
        if (!body.rtspUrl) { statusEl.textContent = "⚠️ Enter an RTSP URL first."; return; }
      } else if (type === "rtmp") {
        body.rtmpUrl = rtmpUrlEl?.value.trim() || "";
        if (!body.rtmpUrl) { statusEl.textContent = "⚠️ Enter an RTMP URL first."; return; }
      } else if (type === "ndi") {
        body.ndiName = ndiNameEl?.value.trim() || "";
        if (!body.ndiName) { statusEl.textContent = "⚠️ Enter an NDI source name first."; return; }
      }
      applyBtn.disabled = true;
      // Show a contextual message — if streaming, we'll stop → switch → restart.
      if (isCurrentlyStreaming) {
        statusEl.style.color = "rgba(255,160,80,0.9)";
        statusEl.textContent = "Switching… stopping stream & reconnecting";
      } else if (type === "rtsp" || type === "rtmp" || type === "ndi") {
        statusEl.textContent = "Connecting… (up to 12 s)";
      } else {
        statusEl.textContent = "Applying…";
      }
      try {
        const r = await fetch(`/api/camera/source?cam=${activeCamIndex}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const data = await r.json();
        if (data.success) {
          // Record the new active source so the button dims again
          activeSource = { ...data.source };
          applyCameraSourceUI(activeSource.type);
          // Refresh resolution capabilities for the newly-active source.
          if (typeof loadCameraCapabilities === "function") loadCameraCapabilities();
          statusEl.style.color = "rgba(80,220,120,0.9)";
          statusEl.textContent = data.streamRestarted ? "✅ Applied — stream restarted" : "✅ Applied";
        } else {
          statusEl.style.color = "rgba(255,160,80,0.9)";
          statusEl.textContent = `⚠️ ${data.error}`;
        }
        setTimeout(() => { statusEl.textContent = ""; statusEl.style.color = ""; }, 6000);
      } catch (e) {
        statusEl.style.color = "rgba(255,160,80,0.9)";
        statusEl.textContent = "⚠️ Network error";
      } finally {
        // Dim if the UI still matches the (possibly reverted) active source
        updateApplyButton();
      }
    });
  }

  // Expose loadDevices so switchCamera() can reload for the new camera.
  reloadCameraInput = loadDevices;

  // Load video device list on page ready.
  // Audio devices are loaded on demand (refresh button) to avoid blocking startup.
  loadDevices();
  updateAudioDeviceRowVisibility();
})();

// Keyboard controls — Arrow = 1 hw step (accelerating), Shift+Arrow = outer-ring speed.
// The browser fires native keydown repeat at ~30–50 Hz which is far faster than
// the camera motor can respond.  We suppress native repeat and drive our own
// PTZ_REPEAT_DELAY / PTZ_REPEAT_INTERVAL loop with the same acceleration curve
// as the inner-ring buttons.
const _heldKeys = new Set();
let _keyDelayTimer   = null;
let _keyRepeatTimer  = null;
let _keyTick         = 0;   // acceleration tick counter, reset on key release

function _clearKeyTimers() {
  if (_keyDelayTimer)  { clearTimeout(_keyDelayTimer);   _keyDelayTimer  = null; }
  if (_keyRepeatTimer) { clearInterval(_keyRepeatTimer); _keyRepeatTimer = null; }
}

document.addEventListener("keydown", (e) => {
  if (!["ArrowLeft","ArrowRight","ArrowUp","ArrowDown"].includes(e.key)) return;
  e.preventDefault();

  // Ignore browser-generated key-repeat events — we handle our own.
  if (_heldKeys.has(e.key)) return;
  _heldKeys.add(e.key);

  // Shift+Arrow: constant outer-ring speed (no ramp).
  // Arrow alone: starts at 1 hw step, accelerates to outer-ring speed on hold.
  const isLarge = e.shiftKey;
  let evt, sign, getMax;
  switch (e.key) {
    case "ArrowLeft":  evt = "pan";  sign = +1; getMax = isLarge ? panLargeSteps  : panAccelSteps;  break;
    case "ArrowRight": evt = "pan";  sign = -1; getMax = isLarge ? panLargeSteps  : panAccelSteps;  break;
    case "ArrowUp":    evt = "tilt"; sign = +1; getMax = isLarge ? tiltLargeSteps : tiltAccelSteps; break;
    case "ArrowDown":  evt = "tilt"; sign = -1; getMax = isLarge ? tiltLargeSteps : tiltAccelSteps; break;
  }

  function fire() {
    const steps = sign * (isLarge ? getMax() : ptzAccelSteps(_keyTick, getMax()));
    socket.emit(evt, { steps, cameraIndex: activeCamIndex });
    _keyTick++;
  }

  _clearKeyTimers();
  _keyTick = 0;
  fire(); // immediate first step
  _keyDelayTimer = setTimeout(() => {
    _keyRepeatTimer = setInterval(fire, PTZ_REPEAT_INTERVAL);
  }, PTZ_REPEAT_DELAY);
});

document.addEventListener("keyup", (e) => {
  if (!_heldKeys.has(e.key)) return;
  _heldKeys.delete(e.key);
  _clearKeyTimers();
  _keyTick = 0;
});

// ============ STREAMING CONTROLS ============

const streamProtocol = document.getElementById("streamProtocol");
const streamDestination = document.getElementById("streamDestination");
const streamBitrate = document.getElementById("streamBitrate");
const streamResolution = document.getElementById("streamResolution");
const streamFramerate = document.getElementById("streamFramerate");
const streamCodec = document.getElementById("streamCodec");
// audioEnabledCheckbox, audioSourceRow, audioSourceTypeSelect,
// audioDeviceRow, audioDeviceSelect, refreshAudioDevicesBtn
// are declared before the initCameraInput IIFE above.
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

// YouTube mode UI helpers
const youtubeKeyRow       = document.getElementById("youtubeKeyRow");
const youtubeKeyHint      = document.getElementById("youtubeKeyHint");
const youtubeStreamKeyInput = document.getElementById("youtubeStreamKey");
const toggleYoutubeKeyBtn = document.getElementById("toggleYoutubeKey");
const destinationLabel    = document.getElementById("destinationLabel");

// Track streaming state
let isCurrentlyStreaming = false;
// Track device IP for connection info
let deviceLocalIP = null;

// Helper: update the connection info box based on protocol and IP
function updateConnectionInfo(protocol, ip) {
  const resolvedIP = ip || deviceLocalIP || "device-ip";
  // Per-camera path and port — Camera 2 uses /live2, :8892; Camera 1 uses /live, :8891
  const rtspSuffix = activeCamIndex === 2 ? "live2" : "live";
  const srtPort    = activeCamIndex === 2 ? 8892 : 8891;
  if (protocol === "rtsp") {
    connectionInfoBox.style.display = "block";
    destinationRow.style.display = "none";
    if (youtubeKeyRow)  youtubeKeyRow.style.display  = "none";
    if (youtubeKeyHint) youtubeKeyHint.style.display = "none";
    connectionUrlEl.textContent = `rtsp://${resolvedIP}:8554/${rtspSuffix}`;
    connectionInfoExtra.innerHTML =
      `<span style="color:rgba(255,255,255,0.45);font-size:10px">` +
      `Also: HLS → <code style="font-size:10px">http://${resolvedIP}:8888/${rtspSuffix}</code>` +
      `&nbsp;&nbsp;SRT → <code style="font-size:10px">srt://${resolvedIP}:8890?streamid=read:${rtspSuffix}</code>` +
      `</span>`;
  } else if (protocol === "srt") {
    connectionInfoBox.style.display = "block";
    destinationRow.style.display = "none";
    if (youtubeKeyRow)  youtubeKeyRow.style.display  = "none";
    if (youtubeKeyHint) youtubeKeyHint.style.display = "none";
    connectionUrlEl.textContent = `srt://${resolvedIP}:${srtPort}`;
    connectionInfoExtra.innerHTML =
      `<span style="color:rgba(255,255,255,0.45);font-size:10px">` +
      `Listener mode — clients connect directly to this device` +
      `</span>`;
  } else if (protocol === "youtube") {
    // YouTube Live — separate Stream URL + Stream Key fields, combined on stream start
    connectionInfoBox.style.display = "none";
    destinationRow.style.display = "";
    if (destinationLabel) destinationLabel.textContent = "Stream URL:";
    if (streamDestination) streamDestination.placeholder = "rtmp://a.rtmp.youtube.com/live2/";
    // Pre-fill URL only if blank or not already a YouTube ingest URL
    if (streamDestination && !streamDestination.value.includes("rtmp.youtube.com")) {
      streamDestination.value = "rtmp://a.rtmp.youtube.com/live2/";
    }
    if (youtubeKeyRow)  youtubeKeyRow.style.display  = "";
    if (youtubeKeyHint) {
      youtubeKeyHint.style.display = "";
      youtubeKeyHint.innerHTML =
        `Get your stream key from <a href="https://studio.youtube.com" target="_blank" rel="noopener" `
        + `style="color:rgba(255,100,100,0.6);text-decoration:underline;">YouTube Studio</a>`
        + ` → Go Live → Stream settings.`;
    }
  } else if (protocol === "facebook") {
    // Facebook Live — same split URL + Key UI as YouTube
    connectionInfoBox.style.display = "none";
    destinationRow.style.display = "";
    if (destinationLabel) destinationLabel.textContent = "Stream URL:";
    if (streamDestination) streamDestination.placeholder = "rtmps://live-api-s.facebook.com:443/rtmp/";
    // Pre-fill URL only if blank or not already a Facebook ingest URL
    if (streamDestination && !streamDestination.value.includes("live-api-s.facebook.com")) {
      streamDestination.value = "rtmps://live-api-s.facebook.com:443/rtmp/";
    }
    if (youtubeKeyRow)  youtubeKeyRow.style.display  = "";
    if (youtubeKeyHint) {
      youtubeKeyHint.style.display = "";
      youtubeKeyHint.innerHTML =
        `Get your stream key from <a href="https://www.facebook.com/live/producer" target="_blank" rel="noopener" `
        + `style="color:rgba(100,149,255,0.8);text-decoration:underline;">Facebook Live Producer</a>`
        + ` → Go Live → Use Stream Key.`;
    }
  } else {
    // Generic RTMP push — single destination field, no key row
    connectionInfoBox.style.display = "none";
    destinationRow.style.display = "";
    if (destinationLabel) destinationLabel.textContent = "Destination:";
    if (streamDestination) streamDestination.placeholder = "rtmp://server/live/stream";
    if (youtubeKeyRow)  youtubeKeyRow.style.display  = "none";
    if (youtubeKeyHint) youtubeKeyHint.style.display = "none";
  }
}

// Copy connection URL to clipboard
if (copyConnectionUrlBtn) {
  copyConnectionUrlBtn.addEventListener("click", () => {
    const url = connectionUrlEl ? connectionUrlEl.textContent.trim() : "";
    if (!url) return;

    const showFeedback = (ok) => {
      copyConnectionUrlBtn.textContent = ok ? "✅ Copied!" : "❌ Failed";
      setTimeout(() => { copyConnectionUrlBtn.textContent = "📋"; }, 1500);
    };

    const execFallback = () => {
      try {
        const ta = document.createElement("textarea");
        ta.value = url;
        ta.style.cssText = "position:fixed;opacity:0;pointer-events:none;";
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        const ok = document.execCommand("copy");
        document.body.removeChild(ta);
        showFeedback(ok);
      } catch (e) {
        showFeedback(false);
      }
    };

    // navigator.clipboard requires a secure context (HTTPS/localhost).
    // The admin UI is served over HTTP so fall back to execCommand directly.
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(url).then(() => showFeedback(true)).catch(execFallback);
    } else {
      execFallback();
    }
  });
}

// Toggle YouTube stream key visibility (password ↔ text)
if (toggleYoutubeKeyBtn && youtubeStreamKeyInput) {
  toggleYoutubeKeyBtn.addEventListener("click", () => {
    const isHidden = youtubeStreamKeyInput.type === "password";
    youtubeStreamKeyInput.type = isHidden ? "text" : "password";
    toggleYoutubeKeyBtn.textContent = isHidden ? "🔒" : "👁";
  });
}

// Build the combined YouTube RTMP destination from the two separate fields.
// Strips any trailing slash from the URL then appends "/" + key.
function buildYoutubeDestination() {
  const url = streamDestination ? streamDestination.value.trim().replace(/\/+$/, "") : "";
  const key = youtubeStreamKeyInput ? youtubeStreamKeyInput.value.trim() : "";
  return key ? `${url}/${key}` : url;
}

// Build the combined Facebook RTMP destination (Stream URL + "/" + Stream Key).
function buildFacebookDestination() {
  const url = streamDestination ? streamDestination.value.trim().replace(/\/+$/, "") : "";
  const key = youtubeStreamKeyInput ? youtubeStreamKeyInput.value.trim() : "";
  return key ? `${url}/${key}` : url;
}

// Initialize connection info box on page load with the default protocol selection
updateConnectionInfo(streamProtocol.value, deviceLocalIP);

// Helper to update stream status display
const streamServerHeaderStatus = document.getElementById("streamServerHeaderStatus");
function setStreamStatus(state, text) {
  streamStatusBar.className = "stream-status-bar";
  let headerBadge = "";
  switch (state) {
    case "idle":
      streamStatusBar.classList.add("status-idle");
      streamStatusText.textContent = "⏹ " + text;
      headerBadge = "⚫ Offline";
      break;
    case "starting":
      streamStatusBar.classList.add("status-starting");
      streamStatusText.textContent = "⏳ " + text;
      headerBadge = "⏳ Starting…";
      break;
    case "stopping":
      streamStatusBar.classList.add("status-stopping");
      streamStatusText.textContent = "⏳ " + text;
      headerBadge = "⏳ Stopping…";
      break;
    case "live":
      streamStatusBar.classList.add("status-live");
      streamStatusText.textContent = "🟢 " + text;
      headerBadge = "🟢 LIVE";
      break;
    case "error":
      streamStatusBar.classList.add("status-error");
      streamStatusText.textContent = "⚠️ " + text;
      headerBadge = "⚠️ Error";
      break;
  }
  if (streamServerHeaderStatus) streamServerHeaderStatus.textContent = headerBadge;
}

// Update UI when protocol changes
streamProtocol.addEventListener("change", () => {
  const protocol = streamProtocol.value;
  updateConnectionInfo(protocol, deviceLocalIP);

  // H.265 is incompatible with RTMP, YouTube, and Facebook (FLV container only supports H.264)
  const h265Option = streamCodec.querySelector('option[value="h265"]');
  if (protocol === "rtmp" || protocol === "youtube" || protocol === "facebook") {
    h265Option.disabled = true;
    if (streamCodec.value === "h265") {
      streamCodec.value = "h264";
      // Sync the custom dropdown label back to H.264
      const codecDropdown = streamCodec.parentElement.querySelector(".custom-dropdown-selected");
      if (codecDropdown) {
        codecDropdown.textContent = "H.264 (all protocols)";
        codecDropdown.dataset.value = "h264";
      }
    }
    // For YouTube, also nudge bitrate to 4 Mbps (YouTube's recommended setting)
    if (protocol === "youtube") {
      streamBitrate.value = "4000000";
      updateCustomDropdownDisplay(streamBitrate);
    }
  } else {
    h265Option.disabled = false;
  }

  // Update protocol custom dropdown display (uses innerHTML for data-html options like YouTube)
  updateCustomDropdownDisplay(streamProtocol);
});

// Start/Restart stream
startStreamBtn.addEventListener("click", async () => {
  // Check if currently streaming (button shows "Restart")
  const isRestart = !stopStreamBtn.disabled;

  // Disable both buttons immediately during transition
  startStreamBtn.disabled = true;
  stopStreamBtn.disabled = true;

  // Parse "1920x1080" → { width: 1920, height: 1080 }
  const [resW, resH] = (streamResolution.value || "1920x1080").split("x").map((n) => parseInt(n, 10));

  // 'youtube' and 'facebook' are UI aliases — the server only understands 'rtmp'.
  // In both modes the full RTMP destination is built by joining the Stream URL
  // field and the Stream Key field; for all other modes use the destination as-is.
  const effectiveProtocol =
    (streamProtocol.value === "youtube" || streamProtocol.value === "facebook")
      ? "rtmp"
      : streamProtocol.value;
  const effectiveDestination =
    streamProtocol.value === "youtube"   ? buildYoutubeDestination()  :
    streamProtocol.value === "facebook"  ? buildFacebookDestination() :
    streamDestination.value;

  if (isRestart) {
    console.log("Restarting stream...");
    // Let the server handle the full stop→start cycle atomically.
    // The browser stays on "Restarting…" the whole time; no intermediate
    // MJPEG preview is opened, so there's no double-stream issue.
    const config = {
      protocol: effectiveProtocol,
      destination: effectiveDestination,
      bitrate: parseInt(streamBitrate.value),
      audioEnabled: audioEnabledCheckbox.checked,
      audioSource: audioSourceTypeSelect ? audioSourceTypeSelect.value : "video",
      audioDevice: audioDeviceSelect ? audioDeviceSelect.value : "",
      audioOffset: audioOffsetInput ? parseInt(audioOffsetInput.value, 10) || 0 : 0,
      width: resW,
      height: resH,
      framerate: parseInt(streamFramerate.value),
      codec: streamCodec.value,
      // flip settings are NOT included here — they are persisted independently
      // via saveFlipConfig() → POST /api/stream/config, so the server always has
      // the current value in streamConfig. Sending them here would cause a race
      // condition on initial page load (checkbox not yet restored) that overwrites
      // a saved flip=true with false.
    };
    console.log("Restarting stream with config:", config);
    socket.emit("restartStream", { ...config, cameraIndex: activeCamIndex });
  } else {
    // Normal start
    const config = {
      protocol: effectiveProtocol,
      destination: effectiveDestination,
      bitrate: parseInt(streamBitrate.value),
      audioEnabled: audioEnabledCheckbox.checked,
      audioSource: audioSourceTypeSelect ? audioSourceTypeSelect.value : "video",
      audioDevice: audioDeviceSelect ? audioDeviceSelect.value : "",
      audioOffset: audioOffsetInput ? parseInt(audioOffsetInput.value, 10) || 0 : 0,
      width: resW,
      height: resH,
      framerate: parseInt(streamFramerate.value),
      codec: streamCodec.value,
      // flip settings omitted — server uses its persisted streamConfig values
    };
    console.log("Starting stream with config:", config);
    socket.emit("startStream", { ...config, cameraIndex: activeCamIndex });
  }
});

// Stop stream
stopStreamBtn.addEventListener("click", () => {
  console.log("Stopping stream");
  startStreamBtn.disabled = true;
  stopStreamBtn.disabled = true;
  socket.emit("stopStream", { cameraIndex: activeCamIndex });
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
socket.on("refreshIdlePreview", (data) => {
  // Only act if this event is for the currently-active camera (or no cameraIndex = broadcast)
  const evtCam = data?.cameraIndex || 1;
  if (evtCam !== activeCamIndex) return;

  if (!isCurrentlyStreaming) {
    console.log(`🔄 [Cam${evtCam}] Refreshing idle preview for overlay changes...`);
    const previewStatus = document.getElementById("overlayPreviewStatus");
    if (previewStatus) {
      previewStatus.textContent = "🔄 Updating preview…";
      previewStatus.style.display = "block";
    }
    const previewPath = activeCamIndex === 2 ? "preview2" : "preview";
    setTimeout(() => {
      switchToWebRTCPreview(previewPath, () => {
        if (previewStatus) previewStatus.style.display = "none";
      });
    }, 400);
  }
});

// previewRefreshNeeded is no longer emitted by the server — preview reconnects
// automatically via the "refreshIdlePreview" event once the idle preview port
// is confirmed ready.  Handler removed.

// Stream status updates
socket.on("streamStatus", (status) => {
  // Always update per-camera tab status dot
  if (status.cameraIndex) {
    updateCameraTabStatus(status.cameraIndex, status.isStreaming);
  }
  // Only update the main UI for the active camera
  if (status.cameraIndex && status.cameraIndex !== activeCamIndex) return;

  console.log(`Stream status [Cam${status.cameraIndex || 1}]:`, status);
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

    // Switch to WebRTC "live" preview when streaming.
    // Cancel any stale pending switch first so we never queue two connections.
    if (_tcpPreviewTimeout)   { clearTimeout(_tcpPreviewTimeout);   _tcpPreviewTimeout   = null; }
    if (_mjpegPreviewTimeout) { clearTimeout(_mjpegPreviewTimeout); _mjpegPreviewTimeout = null; }
    if (_webrtcRetryTimer)    { clearTimeout(_webrtcRetryTimer);    _webrtcRetryTimer    = null; }
    _tcpPreviewTimeout = setTimeout(() => {
      _tcpPreviewTimeout = null;
      // Use the active camera's preview tee branch
      const _livePath = activeCamIndex === 2 ? "preview2" : "preview";
      switchToWebRTCPreview(_livePath);
    }, 2000); // 2 s grace period for GStreamer + MediaMTX to start publishing
  } else {
    // Change Restart button back to Start button
    // Registration gate: keep disabled if device not yet registered
    startStreamBtn.disabled = !deviceRegistered;
    startBtnIcon.textContent = "▶";
    startBtnText.textContent = "Start";
    startStreamBtn.classList.remove("btn-restart");
    startStreamBtn.classList.add("btn-start");

    stopStreamBtn.disabled = true;
    setStreamStatus("idle", "Not Streaming");
    overlayNeedsRestart.style.display = "none";

    // Switch back to WebRTC "preview" path when the stream stops.
    // Cancel any stale pending switch that might be in-flight.
    if (_tcpPreviewTimeout)   { clearTimeout(_tcpPreviewTimeout);   _tcpPreviewTimeout   = null; }
    if (_mjpegPreviewTimeout) { clearTimeout(_mjpegPreviewTimeout); _mjpegPreviewTimeout = null; }
    if (_webrtcRetryTimer)    { clearTimeout(_webrtcRetryTimer);    _webrtcRetryTimer    = null; }
    _mjpegPreviewTimeout = setTimeout(() => {
      _mjpegPreviewTimeout = null;
      const _idlePath = activeCamIndex === 2 ? "preview2" : "preview";
      switchToWebRTCPreview(_idlePath); // idle camera feed via WHEP
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

// Get initial stream status on connect (for both cameras)
socket.on("connect", () => {
  socket.emit("getStreamStatus", { cameraIndex: 1 });
  socket.emit("getStreamStatus", { cameraIndex: 2 });
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

// Inject YouTube logo into the protocol dropdown option before the custom
// dropdown is built. Using JS avoids messy HTML-encoding in the attribute.
(function () {
  const ytOpt = streamProtocol && streamProtocol.querySelector('option[value="youtube"]');
  if (!ytOpt) return;
  // em-based dimensions so the logo scales with whatever font-size CSS sets
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" `
    + `style="width:1.6em;height:1.1em;flex-shrink:0;vertical-align:middle;">`
    + `<path fill="#FF0000" d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136`
    + `C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0`
    + ` .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122`
    + ` 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0`
    + ` 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545`
    + ` 15.568V8.432L15.818 12l-6.273 3.568z"/></svg>`;
  ytOpt.dataset.html =
    `<span style="display:inline-flex;align-items:center;gap:5px;">${svg}YouTube Live</span>`;
})();

(function () {
  const fbOpt = streamProtocol && streamProtocol.querySelector('option[value="facebook"]');
  if (!fbOpt) return;
  // Facebook "f" logo — blue circle with white f
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" `
    + `style="width:1.1em;height:1.1em;flex-shrink:0;vertical-align:middle;">`
    + `<path fill="#1877F2" d="M24 12.073C24 5.405 18.627 0 12 0S0 5.405 0 12.073`
    + `C0 18.1 4.388 23.094 10.125 24v-8.437H7.078v-3.49h3.047v-2.66`
    + `c0-3.025 1.791-4.697 4.533-4.697 1.312 0 2.686.236 2.686.236v2.953`
    + `h-1.514c-1.491 0-1.956.93-1.956 1.884v2.284h3.328l-.532 3.49`
    + `h-2.796V24C19.612 23.094 24 18.1 24 12.073z"/>`
    + `<path fill="#fff" d="M16.671 15.563l.532-3.49h-3.328v-2.284`
    + `c0-.955.465-1.884 1.956-1.884h1.514V4.952s-1.374-.236-2.686-.236`
    + `c-2.742 0-4.533 1.672-4.533 4.697v2.66H7.078v3.49h3.047V24`
    + `a12.13 12.13 0 003.75 0v-8.437h2.796z"/></svg>`;
  fbOpt.dataset.html =
    `<span style="display:inline-flex;align-items:center;gap:5px;">${svg}Facebook Live</span>`;
})();

// Stream control dropdowns
createCustomDropdown(streamProtocol);
createCustomDropdown(streamResolution);
createCustomDropdown(streamBitrate);
createCustomDropdown(streamFramerate);
createCustomDropdown(streamCodec);

// Camera control dropdowns
const exposureAutoSelect = document.getElementById("exposureAuto");
if (exposureAutoSelect) {
  createCustomDropdown(exposureAutoSelect);
}

console.log("✅ Custom dropdowns initialized");

console.log("🚀 app.js loaded!");

// Video preview switching functions
let hlsPlayer = null;

// Pending preview-switch timeout handles — only one should ever be queued at a time.
let _tcpPreviewTimeout   = null;
let _mjpegPreviewTimeout = null;
let _webrtcRetryTimer    = null;   // retry timer when WHEP publisher not yet ready

// Active WebRTC peer connection for the admin preview (null when closed)
let _webrtcPc = null;

// Snapshot polling state
let _snapshotPollActive = false;
let _snapshotBlobUrl    = null;

// Low Bandwidth Mode — when true, all preview modes use periodic JPEG snapshots
// instead of continuous MJPEG/HLS streams.
let lowBandwidthMode = false;

/**
 * Stop snapshot polling, close any active WebRTC session, and cancel any
 * in-flight preview img/video elements.
 * Call this before any operation that will replace or restart the stream.
 */
function cancelCurrentPreviewImg() {
  // Stop snapshot polling immediately
  _snapshotPollActive = false;
  if (_snapshotBlobUrl) { URL.revokeObjectURL(_snapshotBlobUrl); _snapshotBlobUrl = null; }
  const lowBwLabel = document.getElementById("lowBwLabel");
  if (lowBwLabel && !lowBandwidthMode) lowBwLabel.style.display = "none";

  // Cancel any pending WebRTC retry
  if (_webrtcRetryTimer) { clearTimeout(_webrtcRetryTimer); _webrtcRetryTimer = null; }
  // Close the active RTCPeerConnection (idempotent — safe to call if null)
  if (_webrtcPc) { _webrtcPc.close(); _webrtcPc = null; }

  for (const id of ["videoStream", "videoStreamNew"]) {
    const el = document.getElementById(id);
    if (el) {
      el._cancelled = true;
      if (el.tagName === "VIDEO") { el.pause(); el.src = ""; el.srcObject = null; }
      else el.src = "";
      el.remove();
    }
  }
}

/**
 * Low-Bandwidth preview — polls /video/snapshot at the user-selected interval
 * instead of opening a continuous MJPEG/HLS stream.  One HTTP request per
 * interval; ~5–15 KB per frame vs. ~60–200 KB/s for a continuous stream.
 * Works in both idle (GStreamer idle preview) and streaming (port 8555) states.
 */
function switchToSnapshotPreview() {
  console.log("🔄 Switching to low-bandwidth snapshot preview...");
  cancelCurrentPreviewImg(); // tears down any existing MJPEG/HLS/snapshot

  const container = document.querySelector(".video-container");
  const img = document.createElement("img");
  img.id = "videoStream";
  img.alt = "Camera Preview";
  img.style.cssText = "width:100%;height:100%;object-fit:contain;display:block;background:#000";
  container.insertBefore(img, container.firstChild);

  _snapshotPollActive = true;

  const lowBwLabel = document.getElementById("lowBwLabel");
  if (lowBwLabel) lowBwLabel.style.display = "inline";

  async function fetchNext() {
    if (!_snapshotPollActive) return;

    try {
      const resp = await fetch("/video/snapshot?t=" + Date.now());
      if (resp.ok) {
        const blob = await resp.blob();
        if (!_snapshotPollActive) { URL.revokeObjectURL(URL.createObjectURL(blob)); return; }
        const url = URL.createObjectURL(blob);
        if (_snapshotBlobUrl) URL.revokeObjectURL(_snapshotBlobUrl);
        _snapshotBlobUrl = url;
        const el = document.getElementById("videoStream");
        if (el && !el._cancelled) el.src = url;
      }
    } catch (e) {
      // Network error — silently retry on the next interval
      console.warn("📸 Snapshot fetch failed:", e.message);
    }

    if (!_snapshotPollActive) return;
    const secs = parseInt(document.getElementById("snapshotInterval")?.value || "3");
    setTimeout(fetchNext, secs * 1000);
  }

  fetchNext(); // immediate first frame, then recurring
}

/**
 * Switch the preview area to a WebRTC stream delivered via MediaMTX WHEP.
 *
 * @param {string}   streamPath  - MediaMTX path: "preview" (idle) or "live" (streaming)
 * @param {Function} [onConnected] - called once the first video frame arrives
 * @param {number}   [_attempt=0]  - internal retry counter (do not pass from call sites)
 */
async function switchToWebRTCPreview(streamPath, onConnected, _attempt = 0) {
  if (lowBandwidthMode) { switchToSnapshotPreview(); if (typeof onConnected === "function") onConnected(); return; }
  console.log(`🔄 Switching to WebRTC preview (path="${streamPath}", attempt=${_attempt})...`);

  // Tear down everything that might currently own the preview area
  cancelCurrentPreviewImg();

  const container = document.querySelector(".video-container");

  // Create the <video> element that will host the WebRTC stream
  const video = document.createElement("video");
  video.id        = "videoStream";
  video.dataset.webrtc = "1";
  video.muted     = true;
  video.autoplay  = true;
  video.playsInline = true;
  video.style.cssText = "width:100%;height:100%;object-fit:contain;display:block;background:#000";
  container.insertBefore(video, container.firstChild);

  // Notify caller when the first frame actually appears
  video.addEventListener("playing", function onPlaying() {
    video.removeEventListener("playing", onPlaying);
    if (typeof onConnected === "function") { onConnected(); onConnected = null; }
  }, { once: true });

  // Build the RTCPeerConnection (no STUN/TURN needed on a local network)
  const pc = new RTCPeerConnection({ bundlePolicy: "max-bundle" });
  _webrtcPc = pc;

  // WHEP role is "viewer" — video-only receive transceiver.
  // The preview path (rtmp://localhost:1935/preview) carries H264 video only —
  // no audio track.  Adding an audio transceiver causes the browser SDP to
  // include an m=audio section that MediaMTX cannot satisfy, which causes it
  // to ECONNRESET the WHEP connection instead of returning a 201 answer.
  pc.addTransceiver("video", { direction: "recvonly" });

  // Attach incoming media tracks to the <video> element
  pc.ontrack = (evt) => {
    if (evt.streams && evt.streams[0]) video.srcObject = evt.streams[0];
  };

  // Auto-reconnect if the ICE connection breaks unexpectedly
  pc.addEventListener("iceconnectionstatechange", () => {
    if (pc !== _webrtcPc) return; // stale connection
    if (pc.iceConnectionState === "failed" || pc.iceConnectionState === "disconnected") {
      console.warn(`⚠️ WebRTC "${streamPath}" ICE ${pc.iceConnectionState} — reconnecting in 3 s`);
      _webrtcRetryTimer = setTimeout(() => switchToWebRTCPreview(streamPath, null, 0), 3000);
    }
  });

  // Create SDP offer and set it as the local description
  let offer;
  try {
    offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
  } catch (err) {
    console.error("❌ WebRTC createOffer failed:", err);
    if (_webrtcPc === pc) { pc.close(); _webrtcPc = null; }
    return;
  }

  // Wait for ICE gathering to reach "complete" (or 5 s timeout).
  // Do NOT use { once: true } — icegatheringstatechange fires multiple times:
  //   new → gathering → complete
  // Using once resolves on the first event (new→gathering) and sends an SDP
  // offer with no candidates.  MediaMTX has no address to send video to, and
  // since we send no PATCH trickle-ICE requests, the session never connects.
  await new Promise((resolve) => {
    if (pc.iceGatheringState === "complete") { resolve(); return; }
    const onStateChange = () => {
      if (pc.iceGatheringState === "complete") {
        pc.removeEventListener("icegatheringstatechange", onStateChange);
        resolve();
      }
    };
    pc.addEventListener("icegatheringstatechange", onStateChange);
    setTimeout(() => { pc.removeEventListener("icegatheringstatechange", onStateChange); resolve(); }, 5000);
  });

  // Determine the best WHEP URL for this access scenario:
  //
  // • LAN / hotspot / direct NetBird:
  //     whep-base returns the device IP matching this connection (e.g. 192.168.1.81 or
  //     192.168.50.1 or NetBird IP). That host matches window.location.hostname, so the
  //     browser can reach MediaMTX port 8889 directly — no CORS or mixed-content issues.
  //
  // • Reverse proxy (cameras.digitalpool.com/camera/home-1):
  //     whep-base returns the NetBird IP but the page origin is cameras.digitalpool.com.
  //     The browser cannot make a cross-origin or HTTP→HTTPS mixed-content request to
  //     that IP, so we route through the Express WHEP proxy (/api/whep/<path>) which
  //     forwards to MediaMTX on localhost.
  //     The actual media UDP still flows directly over NetBird via the ICE candidates
  //     advertised in the SDP answer — only the signaling goes through the proxy.

  let whepBase = null; // null → fall back to proxy
  try {
    const baseRes = await fetch("/api/stream/whep-base");
    if (baseRes.ok) {
      const data = await baseRes.json();
      if (data.whepBase) whepBase = data.whepBase;
    }
  } catch (_) { /* network error — proxy fallback */ }

  // Use the Express proxy if the whepBase host differs from the page host
  // (different host = reverse proxy scenario where direct access is blocked).
  const whepHost = whepBase ? new URL(whepBase).hostname : null;
  const useProxy = !whepHost || (whepHost !== window.location.hostname);
  // ── WHEP signaling: Socket.IO relay (proxy path) or direct fetch ───────────
  //
  // When accessed via a reverse proxy (NetBird), the Express HTTP WHEP proxy
  // (/api/whep/*) times out because the proxy closes idle HTTP connections before
  // MediaMTX finishes SDP negotiation.  Relaying the offer over the already-open
  // Socket.IO WebSocket avoids this — the WS connection stays alive through
  // the reverse proxy with no request timeout.
  //
  // Direct path (same-host LAN / hotspot / direct NetBird): plain fetch to
  // MediaMTX port 8889 — no proxy involved, no timeout concern.

  let sdpAnswer;

  if (useProxy) {
    // ── Socket.IO relay ───────────────────────────────────────────────────────
    console.log(`📡 WHEP signaling via Socket.IO relay (proxy path, stream="${streamPath}")`);

    const whepResult = await new Promise((resolve) => {
      // One-time listener — the server always emits exactly one "whep-answer"
      // per "whep-offer" it receives, so this is safe even if another session
      // is later initiated (it creates a fresh promise + listener).
      socket.once("whep-answer", resolve);
      socket.emit("whep-offer", { streamPath, sdp: pc.localDescription.sdp });
    });

    if (whepResult.error) {
      console.error(`❌ WHEP socket relay error: ${whepResult.error}`);
      if (_webrtcPc === pc) { pc.close(); _webrtcPc = null; }
      if (_attempt < 12) {
        const delay = Math.min(1000 + _attempt * 500, 4000);
        console.log(`⏳ WHEP "${streamPath}" relay failed — retry ${_attempt + 1}/12 in ${delay} ms`);
        _webrtcRetryTimer = setTimeout(() => switchToWebRTCPreview(streamPath, onConnected, _attempt + 1), delay);
      } else {
        console.warn(`❌ WebRTC "${streamPath}" gave up after 12 attempts — falling back to snapshot`);
        switchToSnapshotPreview();
      }
      return;
    }

    if (whepResult.status === 404 || whepResult.status === 503) {
      if (_webrtcPc === pc) { pc.close(); _webrtcPc = null; }
      if (_attempt < 12) {
        const delay = Math.min(1000 + _attempt * 500, 4000);
        console.log(`⏳ WHEP "${streamPath}" not ready (HTTP ${whepResult.status}) — retry ${_attempt + 1}/12 in ${delay} ms`);
        _webrtcRetryTimer = setTimeout(() => switchToWebRTCPreview(streamPath, onConnected, _attempt + 1), delay);
      } else {
        console.warn(`❌ WebRTC "${streamPath}" gave up after 12 attempts — falling back to snapshot`);
        switchToSnapshotPreview();
      }
      return;
    }

    if (!whepResult.status || whepResult.status < 200 || whepResult.status >= 300) {
      console.error(`❌ WHEP "${streamPath}" unexpected HTTP ${whepResult.status}`);
      if (_webrtcPc === pc) { pc.close(); _webrtcPc = null; }
      return;
    }

    sdpAnswer = whepResult.sdp;

  } else {
    // ── Direct fetch — same host, MediaMTX port 8889 reachable ──────────────
    const whepUrl = `${whepBase}/${streamPath}/whep`;
    console.log(`📡 WHEP URL: ${whepUrl} (direct, base: ${whepBase})`);

    let whepRes;
    try {
      whepRes = await fetch(whepUrl, {
        method: "POST",
        headers: { "Content-Type": "application/sdp" },
        body: pc.localDescription.sdp,
      });
    } catch (err) {
      console.error("❌ WHEP POST network error:", err);
      if (_webrtcPc === pc) { pc.close(); _webrtcPc = null; }
      return;
    }

    // 404/503 = publisher not yet pushing to MediaMTX — retry with back-off
    if (whepRes.status === 404 || whepRes.status === 503) {
      if (_webrtcPc === pc) { pc.close(); _webrtcPc = null; }
      if (_attempt < 12) {
        const delay = Math.min(1000 + _attempt * 500, 4000);
        console.log(`⏳ WHEP "${streamPath}" not ready (HTTP ${whepRes.status}) — retry ${_attempt + 1}/12 in ${delay} ms`);
        _webrtcRetryTimer = setTimeout(() => switchToWebRTCPreview(streamPath, onConnected, _attempt + 1), delay);
      } else {
        console.warn(`❌ WebRTC "${streamPath}" gave up after 12 attempts — falling back to snapshot`);
        switchToSnapshotPreview();
      }
      return;
    }

    if (!whepRes.ok) {
      console.error(`❌ WHEP "${streamPath}" unexpected HTTP ${whepRes.status}`);
      if (_webrtcPc === pc) { pc.close(); _webrtcPc = null; }
      return;
    }

    sdpAnswer = await whepRes.text();
  }

  // Apply the SDP answer returned by MediaMTX
  try {
    await pc.setRemoteDescription({ type: "answer", sdp: sdpAnswer });
    console.log(`✅ WebRTC "${streamPath}" negotiation complete — waiting for first frame`);
  } catch (err) {
    console.error("❌ setRemoteDescription failed:", err);
    if (_webrtcPc === pc) { pc.close(); _webrtcPc = null; }
  }
}

/**
 * Switch the preview area to the live HLS stream served by MediaMTX.
 * Falls back to TCP MJPEG (port 8555) if HLS is unavailable (e.g. SRT mode).
 * When Low Bandwidth Mode is active, defers to switchToSnapshotPreview() instead.
 */
function switchToHLSPreview() {
  if (lowBandwidthMode) { switchToSnapshotPreview(); return; }
  console.log("🔄 Switching to HLS live preview...");
  const container = document.querySelector(".video-container");

  _snapshotPollActive = false; // stop idle snapshot polling
  cancelCurrentPreviewImg();
  if (hlsPlayer) { hlsPlayer.destroy(); hlsPlayer = null; }

  const oldElement = document.getElementById("videoStream");
  if (oldElement) {
    if (oldElement.tagName === "VIDEO") { oldElement.pause(); oldElement.src = ""; }
    oldElement.remove();
  }

  const hlsUrl = "/video/hls-live/index.m3u8";

  // Create <video> element to host the HLS stream
  const video = document.createElement("video");
  video.id = "videoStream";
  video.muted = true;
  video.autoplay = true;
  video.playsInline = true;
  video.style.cssText = "width:100%;height:100%;object-fit:contain;display:block;background:#000";
  container.insertBefore(video, container.firstChild);

  // Fall back to TCP MJPEG if HLS doesn't load within 8 seconds
  let hlsLoaded = false;
  const fallbackTimer = setTimeout(() => {
    if (!hlsLoaded) {
      console.warn("⏱️ HLS timed out — falling back to TCP MJPEG preview");
      if (hlsPlayer) { hlsPlayer.destroy(); hlsPlayer = null; }
      video.remove();
      _switchToTCPMJPEG(container);
    }
  }, 8000);

  function onHlsReady() {
    hlsLoaded = true;
    clearTimeout(fallbackTimer);
    video.play().catch(() => {});
    console.log("✅ HLS live preview playing");

    // On slow connections the player drifts behind the live edge.
    // Every 3 s check; if we're more than 5 s behind, snap back to live.
    const liveEdgeInterval = setInterval(() => {
      if (!hlsPlayer) { clearInterval(liveEdgeInterval); return; }
      const target = hlsPlayer.liveSyncPosition;
      if (target != null && video.currentTime < target - 5) {
        console.log(`🔄 Snapping to live edge (${(target - video.currentTime).toFixed(1)}s behind)`);
        video.currentTime = target;
      }
    }, 3000);
    // Attach so the error handler can clear it
    video._liveEdgeInterval = liveEdgeInterval;
  }

  if (typeof Hls !== "undefined" && Hls.isSupported()) {
    hlsPlayer = new Hls({
      lowLatencyMode:            true,
      backBufferLength:          4,
      maxBufferLength:           8,
      liveSyncDurationCount:     2,
      liveMaxLatencyDurationCount: 5,
    });
    hlsPlayer.loadSource(hlsUrl);
    hlsPlayer.attachMedia(video);
    hlsPlayer.on(Hls.Events.MANIFEST_PARSED, onHlsReady);
    hlsPlayer.on(Hls.Events.ERROR, (_evt, data) => {
      if (data.fatal) {
        console.error("❌ HLS fatal error:", data.details, "— falling back to TCP MJPEG");
        clearTimeout(fallbackTimer);
        if (video._liveEdgeInterval) clearInterval(video._liveEdgeInterval);
        hlsPlayer.destroy(); hlsPlayer = null;
        video.remove();
        _switchToTCPMJPEG(container);
      }
    });
  } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
    // Native HLS (Safari / iOS)
    video.src = hlsUrl;
    video.addEventListener("loadedmetadata", onHlsReady, { once: true });
  } else {
    // No HLS support at all — go straight to TCP MJPEG
    clearTimeout(fallbackTimer);
    video.remove();
    _switchToTCPMJPEG(container);
  }
}

/**
 * TCP MJPEG fallback — used when HLS is unavailable (SRT mode, or MediaMTX not ready).
 * Connects to the GStreamer tcpserversink on port 8555 via the /video/tcp-preview proxy.
 */
function _switchToTCPMJPEG(container) {
  console.log("🔄 Using TCP MJPEG fallback preview...");
  const img = document.createElement("img");
  img.id = "videoStream";
  img.alt = "Camera Stream";
  img.style.cssText = "width:100%;height:100%;object-fit:contain;display:block";
  img.src = "/video/tcp-preview?t=" + Date.now();

  let retryCount = 0;
  img.onerror = function() {
    if (img._cancelled) return;
    retryCount++;
    if (retryCount < 5) {
      setTimeout(() => {
        if (img._cancelled) return;
        img.src = "/video/tcp-preview?t=" + Date.now();
      }, 1000);
    } else {
      console.error("❌ TCP MJPEG preview failed after 5 retries");
    }
  };
  img.onload = () => console.log("✅ TCP MJPEG preview loaded");

  container.insertBefore(img, container.firstChild);
}

/**
 * Idle MJPEG preview — connects to /video/stream (1 fps GStreamer pipeline).
 * Streams continuously as multipart/x-mixed-replace; the browser renders each
 * JPEG as it arrives. Reduced to 1 fps so the TCP buffer stays tiny even on
 * slow/remote connections, preventing the runaway lag that occurred at 5 fps.
 */
function switchToMJPEGPreview(onLoaded) {
  // In Low Bandwidth Mode skip continuous MJPEG and use snapshot polling instead.
  if (lowBandwidthMode) { switchToSnapshotPreview(); if (typeof onLoaded === "function") onLoaded(); return; }
  console.log("🔄 Switching to idle MJPEG preview (1 fps)...");
  const container = document.querySelector(".video-container");
  const oldElement = document.getElementById("videoStream");

  // Tear down HLS player if stream just stopped
  if (hlsPlayer) {
    if (oldElement && oldElement._liveEdgeInterval) clearInterval(oldElement._liveEdgeInterval);
    hlsPlayer.destroy();
    hlsPlayer = null;
  }

  // Tear down any live <video> or stale elements
  if (oldElement) {
    if (oldElement.tagName === "VIDEO") { oldElement.pause(); oldElement.src = ""; }
    else { oldElement._cancelled = true; oldElement.src = ""; }
    oldElement.remove();
  }
  const staleNew = document.getElementById("videoStreamNew");
  if (staleNew) {
    staleNew._cancelled = true;
    if (staleNew.tagName === "VIDEO") { staleNew.pause(); staleNew.src = ""; }
    else staleNew.src = "";
    staleNew.remove();
  }

  const overlaysEnabled = overlayEnabled.checked || showTimestamp.checked || remoteOverlayEnabled.checked;
  const img = document.createElement("img");
  img.id = "videoStream";
  img.alt = "Camera Stream";
  img.style.cssText = "width:100%;height:100%;object-fit:contain;display:block";
  img.src = `/video/stream?overlays=${overlaysEnabled}&t=${Date.now()}`;

  let retryCount = 0;
  img.onerror = function() {
    if (img._cancelled) return;
    retryCount++;
    if (retryCount < 10) {
      setTimeout(() => {
        if (img._cancelled) return;
        img.src = `/video/stream?overlays=${overlaysEnabled}&t=${Date.now()}`;
      }, 1000);
    } else {
      console.error("❌ Idle MJPEG preview failed after 10 retries");
    }
  };
  img.onload = () => {
    console.log("✅ Idle MJPEG preview loaded");
    if (typeof onLoaded === "function") { onLoaded(); onLoaded = null; }
  };

  container.insertBefore(img, container.firstChild);
}

// Canvas overlay removed - preview now shows actual stream output via tee
// Overlay settings still work, they just apply to the GStreamer pipeline
const videoStream = document.getElementById("videoStream");

// ── Outgoing stream FPS display ───────────────────────────────────────────
// Updated by the server polling v4l2-ctl --get-parm every 5 s while streaming.
// Shows "—" when the stream is stopped.
const outgoingFpsEl = document.getElementById("outgoingFps");
socket.on("streamFps", ({ fps }) => {
  if (outgoingFpsEl) {
    outgoingFpsEl.textContent = fps !== null ? fps + " fps" : "—";
  }
});

// ── CPU load display ──────────────────────────────────────────────────────
// Broadcast every 2 s from /proc/stat on the server. Colour-coded by load.
const cpuLoadEl = document.getElementById("cpuLoad");
socket.on("cpuLoad", ({ percent }) => {
  if (!cpuLoadEl) return;
  cpuLoadEl.textContent = percent + "%";
  cpuLoadEl.style.color = percent > 80 ? "#f87171"   // red   — high load
                        : percent > 50 ? "#fbbf24"   // amber — moderate
                        :                "#12c7ff";  // blue  — normal
});

// ── GStreamer drift display ───────────────────────────────────────────────
// Emitted every ~60 s from the GStreamer drift check. Colour-coded by magnitude.
// Positive = GStreamer clock running fast; negative = running slow.
// Displayed as seconds-per-hour (ppm × 3600 / 1e6) for human-relatability.
const streamDriftEl = document.getElementById("streamDrift");
socket.on("streamDrift", ({ ppm }) => {
  if (!streamDriftEl) return;
  if (ppm === null) {
    streamDriftEl.textContent = "—";
    streamDriftEl.style.color = "#12c7ff";
    return;
  }
  const sPerHr = ppm * 0.0036;
  const abs    = Math.abs(sPerHr);
  // 1 decimal under 10 s/hr, integer beyond — keeps the field width steady.
  const shown = abs < 10 ? sPerHr.toFixed(1) : Math.round(sPerHr).toString();
  streamDriftEl.textContent = (sPerHr >= 0 ? "+" : "") + shown + " s/hr";
  streamDriftEl.style.color = abs > 18 ? "#f87171"   // red   — significant drift (>18 s/hr ≈ >5000 ppm)
                            : abs >  4 ? "#fbbf24"   // amber — mild drift       (>4  s/hr ≈ >1100 ppm)
                            :            "#4ade80";  // green — negligible
});

// ── System stats bar ─────────────────────────────────────────────────────────
// Receives "systemStats" events broadcast by the server every 3 seconds.
// Shows CPU package temperature (color-coded), RAM usage, and RAPL power draw.
(function () {
  const tempEl  = document.getElementById("statCpuTemp");
  const ramEl   = document.getElementById("statRam");
  const powerEl = document.getElementById("statPower");

  function updateStats({ cpuTempC, ramUsedGb, ramTotalGb, powerW }) {
    if (tempEl) {
      tempEl.textContent = cpuTempC !== null ? `🌡️ ${cpuTempC}°C` : "🌡️ —";
      // Color-code by temperature: ≤70 = cool (green), ≤85 = warm (amber), >85 = hot (red)
      tempEl.className = "sys-stat" + (
        cpuTempC === null  ? "" :
        cpuTempC > 85      ? " stat-temp-hot" :
        cpuTempC > 70      ? " stat-temp-warm" :
                             " stat-temp-cool"
      );
    }
    if (ramEl) {
      ramEl.textContent = (ramUsedGb !== null && ramTotalGb !== null)
        ? `💾 ${ramUsedGb}/${ramTotalGb} GB`
        : "💾 —";
    }
    if (powerEl) {
      powerEl.textContent = powerW !== null ? `⚡ ${powerW}W` : "⚡ —";
    }
  }

  socket.on("systemStats", updateStats);

  // Also fetch on page load so stats appear immediately without waiting 3 s.
  fetch("/api/system/stats")
    .then(r => r.json())
    .then(d => { if (d.success) updateStats(d); })
    .catch(() => {});
})();

// ── Live TX bitrate sparkline ─────────────────────────────────────────────
// Receives "streamBitrate" events from the server (1 Hz, Mbps).
// Draws a scrolling filled-area chart on a canvas below the video.
(function () {
  const HISTORY = 120; // seconds of data to keep (2 min rolling window)
  const canvas  = document.getElementById("bitrateGraph");
  const wrap    = document.getElementById("bitrateGraphWrap");
  const valEl   = document.getElementById("bitrateValue");
  const maxEl   = document.getElementById("bitrateMax");
  if (!canvas || !wrap || !valEl) return;

  const data = []; // rolling array of Mbps values (null = no data)
  let peakMbps = 0;
  let animFrame = null;

  function draw() {
    animFrame = null;
    const W = canvas.offsetWidth;
    const H = canvas.height;
    if (W === 0 || H === 0) return;
    if (canvas.width !== W) canvas.width = W;

    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, W, H);

    // Determine Y scale from peak (minimum 1 Mbps so axis isn't flat)
    const yMax = Math.max(peakMbps * 1.15, 1);

    const points = data.slice(-HISTORY);
    if (points.length < 2) return;

    // STEP_PX is calculated so that a full HISTORY of samples spans the entire
    // canvas width.  This means the graph always fills edge-to-edge once the
    // 2-minute buffer is complete, regardless of screen/window width.
    // While filling, the newest sample is pinned to the right edge and older
    // samples grow leftward — standard network-monitor behaviour.
    const STEP_PX = W / Math.max(HISTORY - 1, 1);
    const xOf = (i) => W - (points.length - 1 - i) * STEP_PX;

    // Build fill path
    ctx.beginPath();
    let started = false;
    let firstX = null;
    for (let i = 0; i < points.length; i++) {
      const v = points[i];
      const x = xOf(i);
      if (x < 0) { started = false; continue; } // off left edge
      if (v === null) { started = false; continue; }
      const y = H - (v / yMax) * (H - 6) - 2;
      if (!started) { ctx.moveTo(x, y); started = true; if (firstX === null) firstX = x; }
      else ctx.lineTo(x, y);
    }

    // Close fill to bottom
    const lastValidIdx = [...points].reduce((last, v, i) => v !== null ? i : last, -1);
    if (lastValidIdx >= 0 && firstX !== null) {
      ctx.lineTo(xOf(lastValidIdx), H);
      ctx.lineTo(firstX, H);
      ctx.closePath();
      const grad = ctx.createLinearGradient(0, 0, 0, H);
      grad.addColorStop(0, "rgba(18,199,255,0.55)");
      grad.addColorStop(1, "rgba(18,199,255,0.04)");
      ctx.fillStyle = grad;
      ctx.fill();
    }

    // Re-draw the line on top (sharp)
    ctx.beginPath();
    started = false;
    for (let i = 0; i < points.length; i++) {
      const v = points[i];
      const x = xOf(i);
      if (x < 0) { started = false; continue; }
      if (v === null) { started = false; continue; }
      const y = H - (v / yMax) * (H - 6) - 2;
      if (!started) { ctx.moveTo(x, y); started = true; }
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = "#12c7ff";
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Y-axis label (top = yMax)
    ctx.fillStyle = "rgba(255,255,255,0.3)";
    ctx.font = "9px monospace";
    ctx.fillText(yMax.toFixed(1) + " Mbps", 4, 11);
  }

  function schedDraw() {
    if (!animFrame) animFrame = requestAnimationFrame(draw);
  }

  socket.on("streamBitrate", ({ mbps }) => {
    if (mbps === null) {
      // Stream stopped — reset display
      data.length = 0;
      peakMbps = 0;
      wrap.style.display = "none";
      valEl.textContent = "—";
      if (maxEl) maxEl.textContent = "";
      const ctx = canvas.getContext("2d");
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      return;
    }

    wrap.style.display = "block";
    data.push(mbps);
    if (data.length > HISTORY) data.shift();
    if (mbps > peakMbps) peakMbps = mbps;

    valEl.textContent = mbps.toFixed(2);
    if (maxEl) maxEl.textContent = "↑" + peakMbps.toFixed(2);

    schedDraw();
  });

  // Redraw on resize so canvas pixel width stays correct
  window.addEventListener("resize", schedDraw);
})();

// ── Connected Clients panel ───────────────────────────────────────────────────
// Polls /api/stream/viewers every 2 seconds while the stream is active.
// Shows each RTSP viewer's IP, data rate, and a Kick button.
(function () {
  const wrap      = document.getElementById("viewersWrap");
  const countEl   = document.getElementById("viewerCount");
  const listEl    = document.getElementById("viewerList");
  if (!wrap || !countEl || !listEl) return;

  let pollTimer   = null;
  let kickingIds  = new Set(); // IDs currently being kicked (debounce)

  async function fetchViewers() {
    try {
      const r = await fetch("/api/stream/viewers");
      const d = await r.json();
      renderViewers(d.viewers || [], d.bannedIPs || []);
    } catch (_) {
      renderViewers([], []);
    }
  }

  // Shared button style fragments
  const BTN_BASE = `border:none;color:#fff;font-size:10px;padding:2px 5px;border-radius:3px;cursor:pointer;font-family:monospace;white-space:nowrap;`;

  // Format milliseconds into a compact "Xh Ym Zs" duration string.
  // Seconds are shown for the first 2 minutes, then suppressed to keep it tidy.
  function fmtDuration(ms) {
    const totalSec = Math.floor(ms / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    if (h > 0)  return `${h}h ${m}m`;
    if (m >= 2) return `${m}m`;
    return `${m}m ${s}s`;
  }

  // Protocol badge colours (subtle, readable on dark bg)
  const PROTO_COLOR = {
    RTSP:   "rgba(30,120,220,0.85)",
    SRT:    "rgba(30,170,100,0.85)",
    RTMP:   "rgba(200,120,20,0.85)",
    WebRTC: "rgba(140,60,200,0.85)",
  };
  function protoBadge(type) {
    const bg = PROTO_COLOR[type] || "rgba(80,80,80,0.7)";
    return `<span style="font-size:9px;font-family:monospace;background:${bg};color:#fff;padding:1px 4px;border-radius:3px;margin-right:5px;flex-shrink:0;">${type}</span>`;
  }

  function renderViewers(viewers, banned) {
    countEl.textContent = viewers.length;

    // Always keep the panel visible once it has content (banned list persists
    // across stream stop/start).
    const hasContent = viewers.length > 0 || banned.length > 0;
    wrap.style.display = hasContent ? "block" : "none";

    let html = "";

    // ── Active viewers ──────────────────────────────────────────────────────
    if (viewers.length === 0 && banned.length === 0) {
      listEl.innerHTML = '<span style="color:rgba(255,255,255,0.3);">No clients connected</span>';
      return;
    }

    const now = Date.now();
    viewers.forEach((v) => {
      const ip       = v.ip || v.remoteAddr || "unknown";
      const rate     = v.mbps !== null ? v.mbps.toFixed(2) + " Mbps" : "…";
      const duration = v.connectedAt ? fmtDuration(now - v.connectedAt) : "…";
      html += `<div style="display:flex;justify-content:space-between;align-items:center;padding:2px 0;border-bottom:1px solid rgba(255,255,255,0.06);">
        ${protoBadge(v.type)}
        <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${ip}">${ip}</span>
        <span style="color:rgba(255,255,255,0.4);margin:0 4px;min-width:40px;text-align:right;font-size:10px;" title="Connected for ${duration}">${duration}</span>
        <span style="color:#12c7ff;margin:0 6px;min-width:68px;text-align:right;">${rate}</span>
        <button id="kick-${v.id}" data-id="${v.id}" style="${BTN_BASE}background:rgba(200,80,80,0.75);">Kick</button>
        <button id="ban-${v.id}"  data-id="${v.id}" style="${BTN_BASE}background:rgba(160,40,40,0.85);margin-left:3px;">Ban</button>
      </div>`;
    });

    // ── Banned IPs (always shown while panel is open) ───────────────────────
    if (banned.length > 0) {
      html += `<div style="margin-top:4px;padding-top:4px;border-top:1px solid rgba(255,80,80,0.25);">`;
      banned.forEach((ip) => {
        html += `<div style="display:flex;justify-content:space-between;align-items:center;padding:2px 0;">
          <span style="color:rgba(255,100,100,0.75);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${ip}">🚫 ${ip}</span>
          <span style="color:rgba(255,255,255,0.3);margin:0 6px;min-width:68px;text-align:right;">0.00 Mbps</span>
          <button id="unban-${ip.replace(/[.:]/g,'-')}" data-ip="${ip}" style="${BTN_BASE}background:rgba(60,140,60,0.8);">Unban</button>
        </div>`;
      });
      html += `</div>`;
    }

    listEl.innerHTML = html;

    // ── Wire up Kick buttons ────────────────────────────────────────────────
    viewers.forEach((v) => {
      const btn = document.getElementById(`kick-${v.id}`);
      if (!btn) return;
      btn.addEventListener("click", async () => {
        if (kickingIds.has(v.id)) return;
        kickingIds.add(v.id);
        btn.textContent = "…"; btn.disabled = true;
        try {
          await fetch(`/api/stream/kick/${v.id}`, { method: "POST" });
        } catch (_) { /* ignore */ } finally {
          kickingIds.delete(v.id);
          await fetchViewers();
        }
      });
    });

    // ── Wire up Ban buttons ─────────────────────────────────────────────────
    viewers.forEach((v) => {
      const btn = document.getElementById(`ban-${v.id}`);
      if (!btn) return;
      btn.addEventListener("click", async () => {
        if (kickingIds.has(v.id)) return;
        kickingIds.add(v.id);
        btn.textContent = "…"; btn.disabled = true;
        try {
          await fetch(`/api/stream/ban/${v.id}`, { method: "POST" });
        } catch (_) { /* ignore */ } finally {
          kickingIds.delete(v.id);
          await fetchViewers();
        }
      });
    });

    // ── Wire up Unban buttons ───────────────────────────────────────────────
    banned.forEach((ip) => {
      const btnId = `unban-${ip.replace(/[.:]/g, "-")}`;
      const btn = document.getElementById(btnId);
      if (!btn) return;
      btn.addEventListener("click", async () => {
        btn.textContent = "…"; btn.disabled = true;
        try {
          await fetch("/api/stream/unban", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ip }),
          });
        } catch (_) { /* ignore */ } finally {
          await fetchViewers();
        }
      });
    });
  }

  function startPolling() {
    // Only start the interval once; renderViewers() controls visibility.
    if (!pollTimer) {
      fetchViewers();
      pollTimer = setInterval(fetchViewers, 2000);
    }
  }

  function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    // Fetch one last time so the banned-IP list stays visible even when
    // the stream is stopped — banned entries persist regardless of stream state.
    fetchViewers();
  }

  // Show banned IPs immediately on page load (even before the stream starts)
  fetchViewers();

  // Tie polling lifecycle to the stream — start interval when live, stop when idle.
  socket.on("streamBitrate", ({ mbps }) => {
    if (mbps !== null) startPolling();
    else stopPolling();
  });
})();

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
  overlayEnabled: true,
  overlayType: "text",
  overlayText: "DigitalPool",
  showTimestamp: true,
  remoteOverlayEnabled: false,
  overlayUrl: "",
  timestampPosition: "bottom-right",
  titlePosition: "bottom-left",
  // Per-element formatting
  titleFontSize: 12,
  titleColor: "white",
  titleBackground: "transparent",
  timestampFontSize: 6,
  timestampColor: "white",
  timestampBackground: "transparent",
  // Legacy shared (kept for backward compat with server)
  overlayFontSize: 12,
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
  socket.emit("updateOverlay", { ...overlayConfig, cameraIndex: activeCamIndex });

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

// Load overlay settings from stream status (only for active camera)
socket.on("streamStatus", (status) => {
  if (status.cameraIndex && status.cameraIndex !== activeCamIndex) return;
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

// ── Audio device helpers (module scope so loadStreamConfig can call them) ──────

function updateAudioDeviceRowVisibility() {
  const sourceTypeEl = document.getElementById("cameraSourceType");
  const inputType    = sourceTypeEl ? sourceTypeEl.value : "usb";
  const audioEnabled = audioEnabledCheckbox && audioEnabledCheckbox.checked;
  const audioSource  = audioSourceTypeSelect ? audioSourceTypeSelect.value : "video";

  // "Audio From" selector only makes sense for RTSP, RTMP, and NDI sources, which
  // carry embedded audio.  For USB the audio always comes from an ALSA device, so
  // the "From video source" option would be misleading — hide the selector in that case.
  const showAudioSourcePicker = audioEnabled && (inputType === "rtsp" || inputType === "rtmp" || inputType === "ndi");
  if (audioSourceRow) {
    audioSourceRow.style.display = showAudioSourcePicker ? "" : "none";
  }

  // ALSA device picker is visible when:
  //   • USB source (audio always from ALSA), or
  //   • RTSP/NDI source AND user has selected "External device"
  const showDevicePicker = audioEnabled && (inputType === "usb" || audioSource === "external");
  if (audioDeviceRow) {
    audioDeviceRow.style.display = showDevicePicker ? "" : "none";
  }

  // A/V offset row is visible whenever audio is enabled (applies to all sources).
  if (audioOffsetRow) {
    audioOffsetRow.style.display = audioEnabled ? "" : "none";
  }
}

async function loadAudioDevices() {
  if (!audioDeviceSelect) return;
  audioDeviceSelect.innerHTML = "<option>Scanning…</option>";
  try {
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), 5000);
    const r = await fetch(`/api/audio/devices?cam=${activeCamIndex}`, { signal: ctrl.signal });
    clearTimeout(tid);
    const data = await r.json();
    audioDeviceSelect.innerHTML = "";
    if (!data.devices || data.devices.length === 0) {
      audioDeviceSelect.innerHTML = "<option value=''>No audio devices found</option>";
      return;
    }
    data.devices.forEach(({ device, name }) => {
      const opt = document.createElement("option");
      opt.value = device;
      opt.textContent = name;
      audioDeviceSelect.appendChild(opt);
    });
    // Pre-select priority:
    //  1. The device saved in streamConfig for this camera (dataset.savedDevice,
    //     updated by loadStreamConfig() on every camera tab switch).
    //  2. The server's auto-detected current device (data.current) — used when
    //     no device has been explicitly saved yet (empty audioDevice in config).
    // If the saved device string isn't present in the populated list (e.g. it was
    // saved on a different machine or the card number changed), fall back to
    // data.current so the user always sees a valid, usable selection.
    const saved = audioDeviceSelect.dataset.savedDevice;
    const preferred = saved || data.current;
    if (preferred) {
      audioDeviceSelect.value = preferred;
      // If the preferred value wasn't found in the list, fall back to data.current.
      if (audioDeviceSelect.value !== preferred && data.current) {
        audioDeviceSelect.value = data.current;
      }
    }
    // Mark that devices have been loaded at least once so switchCamera() can
    // auto-refresh the list (and selection) on subsequent tab switches.
    _audioDevicesLoaded = true;
  } catch (e) {
    audioDeviceSelect.innerHTML = "<option value=''>Error — click 🔄 to retry</option>";
  }
}

// Load stream configuration on page load
async function loadStreamConfig() {
  try {
    const response = await fetch(`/api/stream/config?cam=${activeCamIndex}`);
    const data = await response.json();
    if (data.success && data.config) {
      console.log("📡 Loaded stream config:", data.config);

      // Update UI with saved settings.
      // Detect YouTube/Facebook mode: the server normalises both → 'rtmp' in startStream,
      // so after the first stream the saved protocol is 'rtmp'. Re-detect by URL.
      const savedProtocol    = data.config.protocol || "rtsp";
      const savedDestination = data.config.destination || "";
      const isYoutubeMode  = savedProtocol === "youtube" ||
        (savedProtocol === "rtmp" && savedDestination.includes("rtmp.youtube.com"));
      const isFacebookMode = savedProtocol === "facebook" ||
        (savedProtocol === "rtmp" && savedDestination.includes("live-api-s.facebook.com"));

      if (isYoutubeMode) {
        streamProtocol.value = "youtube";
      } else if (isFacebookMode) {
        streamProtocol.value = "facebook";
      } else {
        streamProtocol.value = savedProtocol;
      }

      if (isYoutubeMode && savedDestination) {
        // Split combined URL back into Stream URL + Stream Key fields.
        // The key always follows "live2/" in the YouTube ingest URL.
        const live2idx = savedDestination.indexOf("live2/");
        if (live2idx !== -1) {
          streamDestination.value = savedDestination.slice(0, live2idx + 6); // "…/live2/"
          if (youtubeStreamKeyInput) youtubeStreamKeyInput.value = savedDestination.slice(live2idx + 6);
        } else {
          streamDestination.value = savedDestination;
        }
      } else if (isFacebookMode && savedDestination) {
        // Split combined URL back into Stream URL + Stream Key fields.
        // The key follows "/rtmp/" in the Facebook ingest URL.
        const rtmpIdx = savedDestination.indexOf("/rtmp/");
        if (rtmpIdx !== -1) {
          streamDestination.value = savedDestination.slice(0, rtmpIdx + 6); // "…/rtmp/"
          if (youtubeStreamKeyInput) youtubeStreamKeyInput.value = savedDestination.slice(rtmpIdx + 6);
        } else {
          streamDestination.value = savedDestination;
        }
      } else {
        streamDestination.value = savedDestination;
      }
      streamBitrate.value = data.config.bitrate || 5000000;
      streamFramerate.value = data.config.framerate || 30;
      streamCodec.value = data.config.codec || "h264";
      const w = data.config.width || 1920, h = data.config.height || 1080;
      const resKey = `${w}x${h}`;
      // Only assign if the option exists; otherwise fall back to 1080p.
      streamResolution.value = Array.from(streamResolution.options).some((o) => o.value === resKey) ? resKey : "1920x1080";
      audioEnabledCheckbox.checked = data.config.audioEnabled !== false; // default true

      // Restore audio source type selection (default "video").
      if (audioSourceTypeSelect) {
        audioSourceTypeSelect.value = data.config.audioSource || "video";
      }

      // Store the saved audio device so loadAudioDevices() can pre-select it.
      // We do NOT trigger an arecord scan here — it can be slow and would block
      // the page startup.  switchCamera() triggers loadAudioDevices() automatically
      // once the user has loaded devices at least once (_audioDevicesLoaded flag).
      if (audioDeviceSelect) {
        const dev = data.config.audioDevice || "";
        audioDeviceSelect.dataset.savedDevice = dev;
        // If the dropdown is already populated (user previously clicked 🔄),
        // immediately update the selected option so switching tabs gives instant
        // visual feedback without waiting for the async loadAudioDevices() call.
        if (_audioDevicesLoaded && dev && audioDeviceSelect.options.length > 0 &&
            audioDeviceSelect.options[0].value) {
          audioDeviceSelect.value = dev;
        }
      }

      // Restore A/V sync offset (default 0).
      if (audioOffsetInput) {
        audioOffsetInput.value = data.config.audioOffset ?? 0;
      }

      updateAudioDeviceRowVisibility();

      // Enforce H.265 restriction on RTMP, YouTube, and Facebook (FLV container only supports H.264)
      const h265Option = streamCodec.querySelector('option[value="h265"]');
      if (isYoutubeMode || isFacebookMode || savedProtocol === "rtmp") {
        h265Option.disabled = true;
        if (streamCodec.value === "h265") streamCodec.value = "h264";
      } else {
        h265Option.disabled = false;
      }

      // Update custom dropdowns (updateCustomDropdownDisplay handles data-html / SVG logos)
      updateCustomDropdownDisplay(streamProtocol);

      const bitrateDropdown = streamBitrate.parentElement.querySelector(
        ".custom-dropdown-selected",
      );
      if (bitrateDropdown) {
        const bitrateOption =
          streamBitrate.options[streamBitrate.selectedIndex];
        bitrateDropdown.textContent = bitrateOption.text;
        bitrateDropdown.dataset.value = bitrateOption.value;
      }

      const framerateDropdown = streamFramerate.parentElement.querySelector(
        ".custom-dropdown-selected",
      );
      if (framerateDropdown) {
        const framerateOption =
          streamFramerate.options[streamFramerate.selectedIndex];
        framerateDropdown.textContent = framerateOption.text;
        framerateDropdown.dataset.value = framerateOption.value;
      }

      const codecDropdown = streamCodec.parentElement.querySelector(
        ".custom-dropdown-selected",
      );
      if (codecDropdown) {
        const codecOption = streamCodec.options[streamCodec.selectedIndex];
        codecDropdown.textContent = codecOption.text;
        codecDropdown.dataset.value = codecOption.value;
      }

      updateCustomDropdownDisplay(streamResolution);

      // Show/hide destination field and connection info box based on UI protocol selection
      updateConnectionInfo(streamProtocol.value, deviceLocalIP);

      // Restore video orientation (flip) settings
      if (flipHorizontalCheckbox) flipHorizontalCheckbox.checked = data.config.flipHorizontal || false;
      if (flipVerticalCheckbox)   flipVerticalCheckbox.checked   = data.config.flipVertical   || false;
      if (panInvertedCheckbox)    panInvertedCheckbox.checked    = data.config.panInverted    || false;

      // Apply fps constraints implied by current resolution, then refresh
      // capability info so unsupported resolutions get greyed out.
      applyResolutionConstraints();
      loadCameraCapabilities();
    }
  } catch (error) {
    console.error("❌ Error loading stream config:", error);
  }
}

// Save flip orientation to server.
// • Not streaming → shows "🔄 Applying flip…" banner; server restarts idle preview
//   and emits refreshIdlePreview, which hides the banner once the first frame arrives.
// • Streaming → shows existing "Restarting Stream…" UI via restartStream socket event.
async function saveFlipConfig() {
  const flipHorizontal = flipHorizontalCheckbox ? flipHorizontalCheckbox.checked : false;
  const flipVertical   = flipVerticalCheckbox   ? flipVerticalCheckbox.checked   : false;
  const panInverted    = panInvertedCheckbox    ? panInvertedCheckbox.checked    : false;

  // Show progress feedback immediately — before the network round-trip.
  const previewStatus = document.getElementById("overlayPreviewStatus");
  if (!isCurrentlyStreaming && previewStatus) {
    previewStatus.textContent = "🔄 Applying flip…";
    previewStatus.style.display = "block";
  }

  try {
    const resp = await fetch(`/api/stream/config?cam=${activeCamIndex}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ flipHorizontal, flipVertical, panInverted }),
    });
    const result = await resp.json();
    console.log(`🔄 Flip config saved — H=${flipHorizontal} V=${flipVertical}`);

    if (result.restartStreamNeeded) {
      // Stream is live — use the atomic restartStream path so the existing
      // "Restarting…" status UI and preview switching are handled consistently.
      // The POST above already saved the new flip values to streamConfig on the
      // server, so we do NOT include flip here — the server uses its saved values.
      const [resW, resH] = streamResolution.value.split("x").map(Number);
      const config = {
        protocol:     streamProtocol.value,
        destination:  streamDestination.value,
        bitrate:      parseInt(streamBitrate.value),
        audioEnabled: audioEnabledCheckbox ? audioEnabledCheckbox.checked : true,
        audioSource:  audioSourceTypeSelect ? audioSourceTypeSelect.value : "video",
        audioDevice:  audioDeviceSelect ? audioDeviceSelect.value : "",
        audioOffset:  audioOffsetInput ? parseInt(audioOffsetInput.value, 10) || 0 : 0,
        width:        resW,
        height:       resH,
        framerate:    parseInt(streamFramerate.value),
        codec:        streamCodec.value,
      };
      socket.emit("restartStream", { ...config, cameraIndex: activeCamIndex });
    }
    // If not streaming: the server emits refreshIdlePreview which triggers
    // switchToWebRTCPreview() → its onConnected callback resets the banner text
    // and hides it once the first frame arrives.
  } catch (err) {
    console.error("❌ Failed to save flip config:", err);
    if (previewStatus && !isCurrentlyStreaming) previewStatus.style.display = "none";
  }
}

// Wire flip / pan-invert checkbox change events
if (flipHorizontalCheckbox) flipHorizontalCheckbox.addEventListener("change", saveFlipConfig);
if (flipVerticalCheckbox)   flipVerticalCheckbox.addEventListener("change", saveFlipConfig);
if (panInvertedCheckbox)    panInvertedCheckbox.addEventListener("change", saveFlipConfig);

// Disable a custom-dropdown option (both the underlying <option> and its
// rendered .custom-dropdown-option div). When the currently-selected value
// becomes disabled, snap to fallbackValue.
function setStreamOptionDisabled(selectEl, value, disabled, fallbackValue) {
  const opt = Array.from(selectEl.options).find((o) => o.value === value);
  if (opt) opt.disabled = disabled;
  const optionsContainer = selectEl.parentElement.querySelector(".custom-dropdown-options");
  if (optionsContainer) {
    const div = optionsContainer.querySelector(`.custom-dropdown-option[data-value="${value}"]`);
    if (div) {
      div.style.opacity       = disabled ? "0.35" : "";
      div.style.pointerEvents = disabled ? "none" : "";
      div.style.cursor        = disabled ? "not-allowed" : "";
    }
  }
  if (disabled && selectEl.value === value && fallbackValue != null) {
    selectEl.value = fallbackValue;
    updateCustomDropdownDisplay(selectEl);
    selectEl.dispatchEvent(new Event("change", { bubbles: true }));
  }
}

// 4K caps the encoder at 30 fps on the Orange Pi 5 — disable 50/60 in that case.
function applyResolutionConstraints() {
  const is4K = streamResolution && streamResolution.value === "3840x2160";
  setStreamOptionDisabled(streamFramerate, "50", is4K, "30");
  setStreamOptionDisabled(streamFramerate, "60", is4K, "30");
}

// Query the backend for what the active source can deliver, and disable
// resolutions the camera doesn't advertise. Call after loadStreamConfig and
// after a successful camera-source switch.
async function loadCameraCapabilities() {
  if (!streamResolution) return;
  try {
    const r = await fetch(`/api/camera/capabilities?cam=${activeCamIndex}`);
    const d = await r.json();
    setStreamOptionDisabled(streamResolution, "1280x720",  !d.supports720p,  "1920x1080");
    setStreamOptionDisabled(streamResolution, "1920x1080", !d.supports1080p, "1280x720");
    setStreamOptionDisabled(streamResolution, "3840x2160", !d.supports4K,    "1920x1080");
    applyResolutionConstraints();
  } catch (e) {
    console.warn("⚠️  Could not load camera capabilities:", e.message);
  }
}

if (streamResolution) {
  streamResolution.addEventListener("change", applyResolutionConstraints);
}

// Load stream config on page load
loadStreamConfig();

// Fetch and display device IP address.
// Prefers the Ethernet IP so the streaming URL (RTSP/SRT) always shows
// the correct address for OBS and other clients, even when the admin UI
// is being viewed from the WiFi hotspot (192.168.50.1).
const AP_IP = "192.168.50.1";
async function loadDeviceIp() {
  try {
    const response = await fetch("/api/network");
    const data = await response.json();
    if (data.success && data.addresses.length > 0) {
      // Priority: 1) Ethernet (eth* / en*), 2) any non-AP address, 3) first address
      const eth   = data.addresses.find(a => /^e(th|n)/.test(a.interface));
      const nonAp = data.addresses.find(a => a.address !== AP_IP);
      deviceLocalIP = (eth || nonAp || data.addresses[0]).address;
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
    // Start collapsed
    body.style.display = "none";
    chevron.textContent = "▶";

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

  // ── Ethernet / network status ───────────────────────────────
  async function loadNetworkStatus() {
    try {
      const r = await fetch("/api/network");
      const d = await r.json();
      if (!d.success) return;

      // Separate Ethernet from WiFi addresses
      const ethAddrs  = d.addresses.filter(a => /^e(th|n)/.test(a.interface));
      const allNonAp  = d.addresses.filter(a => a.interface !== 'lo');

      const ethEl  = document.getElementById("ethernetStatus");
      const ethIpEl = document.getElementById("ethernetIp");
      const allEl  = document.getElementById("allIps");

      if (ethEl) {
        if (ethAddrs.length) {
          ethEl.textContent = "🟢 Connected";
          ethEl.style.color = "#4ade80";
        } else {
          ethEl.textContent = "🔴 Not connected";
          ethEl.style.color = "#f87171";
        }
      }
      if (ethIpEl) {
        ethIpEl.textContent = ethAddrs.length ? ethAddrs.map(a => a.address).join(', ') : '—';
      }
      if (allEl) {
        allEl.textContent = allNonAp.map(a => `${a.interface}: ${a.address}`).join('\n') || '—';
      }
    } catch (e) {
      console.warn("Network status fetch failed:", e.message);
    }
  }

  // ── WiFi client (USB dongle) status + scan/connect ──────────
  const wifiUnavail    = document.getElementById("wifiClientUnavailable");
  const wifiAvail      = document.getElementById("wifiClientAvailable");
  const wifiStatusEl   = document.getElementById("wifiClientStatus");
  const wifiSsidRow    = document.getElementById("wifiClientSsidRow");
  const wifiSsidEl     = document.getElementById("wifiClientSsid");
  const wifiIpRow      = document.getElementById("wifiClientIpRow");
  const wifiIpEl       = document.getElementById("wifiClientIp");
  const wifiDisconnBtn = document.getElementById("wifiDisconnectBtn");
  const wifiConnectDetails = document.getElementById("wifiConnectDetails");

  function showWifiMsg(text, isError = false) {
    const el = document.getElementById("wifiClientMsg");
    if (!el) return;
    el.textContent = text;
    el.style.color = isError ? "#f87171" : "#4ade80";
    if (!isError) setTimeout(() => { el.textContent = ""; }, 5000);
  }

  async function loadWifiClientStatus() {
    try {
      const r = await fetch("/api/wifi/client/status");
      const d = await r.json();
      if (!d.success || !d.available) {
        if (wifiUnavail) wifiUnavail.style.display = "";
        if (wifiAvail)   wifiAvail.style.display   = "none";
        return;
      }
      if (wifiUnavail) wifiUnavail.style.display = "none";
      if (wifiAvail)   wifiAvail.style.display   = "";

      const connected = d.state === "connected";
      if (wifiStatusEl) {
        wifiStatusEl.textContent = connected ? "🟢 Connected" : "⚪ Not connected";
        wifiStatusEl.style.color = connected ? "#4ade80" : "rgba(255,255,255,0.5)";
      }
      if (wifiSsidRow) wifiSsidRow.style.display = connected ? "flex" : "none";
      if (wifiSsidEl)  wifiSsidEl.textContent    = d.ssid || "—";
      if (wifiIpRow)   wifiIpRow.style.display   = (connected && d.ip) ? "flex" : "none";
      if (wifiIpEl)    wifiIpEl.textContent       = d.ip || "—";
      if (wifiDisconnBtn) wifiDisconnBtn.style.display = connected ? "" : "none";
    } catch (e) {
      console.warn("WiFi client status fetch failed:", e.message);
    }
  }

  // Scan button — populate the dropdown
  document.getElementById("wifiScanBtn")?.addEventListener("click", async () => {
    const btn    = document.getElementById("wifiScanBtn");
    const select = document.getElementById("wifiNetworkSelect");
    if (!select) return;
    btn.disabled = true;
    btn.textContent = "⏳";
    select.innerHTML = '<option value="">Scanning…</option>';
    try {
      const r = await fetch("/api/wifi/networks");
      const d = await r.json();
      select.innerHTML = '<option value="">— Select network —</option>';
      if (d.success && d.networks?.length) {
        d.networks.forEach(n => {
          const opt = document.createElement("option");
          opt.value = n.ssid;
          const bars = n.signal >= 75 ? "▂▄▆█" : n.signal >= 50 ? "▂▄▆_" : n.signal >= 25 ? "▂▄__" : "▂___";
          const lock = n.security ? " 🔒" : "";
          opt.textContent = `${n.ssid}  ${bars}${lock}`;
          opt.dataset.security = n.security || "";
          select.appendChild(opt);
        });
      } else {
        select.innerHTML = '<option value="">No networks found</option>';
      }
    } catch (e) {
      select.innerHTML = '<option value="">Scan failed</option>';
    } finally {
      btn.disabled = false;
      btn.textContent = "🔍";
    }
  });

  // Show/hide password field based on selected network's security
  document.getElementById("wifiNetworkSelect")?.addEventListener("change", function () {
    const opt = this.options[this.selectedIndex];
    const hasSecurity = opt?.dataset.security && opt.dataset.security !== "";
    const pwRow = document.getElementById("wifiPasswordRow");
    if (pwRow) pwRow.style.display = (hasSecurity && this.value) ? "" : "none";
  });

  // Connect button
  document.getElementById("wifiConnectBtn")?.addEventListener("click", async () => {
    const ssid = document.getElementById("wifiNetworkSelect")?.value;
    const pw   = document.getElementById("wifiPassword")?.value.trim();
    if (!ssid) { showWifiMsg("Select a network first", true); return; }
    showWifiMsg("⏳ Connecting…");
    const btn = document.getElementById("wifiConnectBtn");
    btn.disabled = true;
    try {
      const r = await fetch("/api/wifi/connect", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ssid, password: pw || undefined }),
      });
      const d = await r.json();
      if (d.success) {
        showWifiMsg(`✅ Connected to ${ssid}`);
        if (wifiConnectDetails) wifiConnectDetails.open = false;
        await loadWifiClientStatus();
      } else {
        showWifiMsg(`❌ ${d.error || "Connection failed"}`, true);
      }
    } catch (e) {
      showWifiMsg(`❌ ${e.message}`, true);
    } finally {
      btn.disabled = false;
    }
  });

  // Disconnect button
  document.getElementById("wifiDisconnectBtn")?.addEventListener("click", async () => {
    showWifiMsg("⏳ Disconnecting…");
    const btn = document.getElementById("wifiDisconnectBtn");
    btn.disabled = true;
    try {
      const r = await fetch("/api/wifi/disconnect", { method: "POST" });
      const d = await r.json();
      if (d.success) {
        showWifiMsg("✅ Disconnected");
        await loadWifiClientStatus();
      } else {
        showWifiMsg(`❌ ${d.error}`, true);
      }
    } catch (e) {
      showWifiMsg(`❌ ${e.message}`, true);
    } finally {
      btn.disabled = false;
    }
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

  // ── Ethernet IP config ──────────────────────────────────────
  async function loadEthernetConfig() {
    try {
      const r = await fetch("/api/ethernet/config");
      const d = await r.json();
      if (!d.success) return;

      const dhcpRadio    = document.getElementById("ethModeDhcp");
      const staticRadio  = document.getElementById("ethModeStatic");
      const staticFields = document.getElementById("ethStaticFields");

      if (d.method === 'static') {
        if (staticRadio)  staticRadio.checked = true;
        if (staticFields) staticFields.style.display = 'flex';
        const set = (id, val) => { const el = document.getElementById(id); if (el) el.value = val || ''; };
        set("ethIp",      d.ip);
        set("ethPrefix",  d.prefix || '24');
        set("ethGateway", d.gateway);
        set("ethDns",     d.dns);
      } else {
        if (dhcpRadio)    dhcpRadio.checked = true;
        if (staticFields) staticFields.style.display = 'none';
      }
    } catch (e) {
      console.warn("Ethernet config fetch failed:", e.message);
    }
  }

  // Show/hide static fields when mode radio changes
  ['ethModeDhcp', 'ethModeStatic'].forEach(id => {
    document.getElementById(id)?.addEventListener('change', () => {
      const isStatic = document.getElementById("ethModeStatic")?.checked;
      const sf = document.getElementById("ethStaticFields");
      if (sf) sf.style.display = isStatic ? 'flex' : 'none';
    });
  });

  // ── Ethernet warning modal helpers ─────────────────────────────────────
  const ethModal       = document.getElementById("ethWarningModal");
  const ethModalAddr   = document.getElementById("ethModalNewAddress");
  const ethModalCancel = document.getElementById("ethWarningCancel");
  const ethModalConfirm= document.getElementById("ethWarningConfirm");

  function showEthModal(labelText) {
    if (ethModalAddr) ethModalAddr.textContent = labelText;
    if (ethModal)     ethModal.style.display = "flex";
  }
  function hideEthModal() {
    if (ethModal) ethModal.style.display = "none";
  }

  ethModalCancel?.addEventListener("click", hideEthModal);
  // Close on backdrop click
  ethModal?.addEventListener("click", (e) => { if (e.target === ethModal) hideEthModal(); });

  // The actual save — called after the user confirms in the modal
  async function _doSaveEthConfig() {
    hideEthModal();
    const btn = document.getElementById("saveEthConfig");
    const msg = document.getElementById("ethConfigMsg");
    const method = document.getElementById("ethModeStatic")?.checked ? "static" : "dhcp";

    btn.disabled = true;
    btn.textContent = "Saving…";
    try {
      const body = {
        method,
        ip:      document.getElementById("ethIp")?.value.trim()      || undefined,
        prefix:  document.getElementById("ethPrefix")?.value          || '24',
        gateway: document.getElementById("ethGateway")?.value.trim() || undefined,
        dns:     document.getElementById("ethDns")?.value.trim()     || undefined,
      };
      const r = await fetch("/api/ethernet/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const d = await r.json();
      if (d.success) {
        showMsg(msg, `✅ ${d.message}`);
        setTimeout(loadNetworkStatus, 3000);
      } else {
        showMsg(msg, `❌ ${d.error}`, true);
      }
    } catch (e) {
      showMsg(msg, `❌ ${e.message}`, true);
    } finally {
      btn.disabled = false;
      btn.textContent = "💾 Save Ethernet Config";
    }
  }

  ethModalConfirm?.addEventListener("click", _doSaveEthConfig);

  // Save button — validate then show the warning modal
  document.getElementById("saveEthConfig")?.addEventListener("click", () => {
    const msg    = document.getElementById("ethConfigMsg");
    const method = document.getElementById("ethModeStatic")?.checked ? "static" : "dhcp";
    const port   = window.location.port || "3000";

    if (method === 'static') {
      const ip = document.getElementById("ethIp")?.value.trim();
      if (!ip) { showMsg(msg, "IP address is required for static mode", true); return; }
      const prefix = document.getElementById("ethPrefix")?.value || '24';
      showEthModal(`http://${ip}:${port}`);
    } else {
      // DHCP — new IP will be assigned by router; user won't know it in advance
      showEthModal("New DHCP address (check your router)");
    }
  });

  // ── kick off ────────────────────────────────────────────────
  loadWifiStatus();
  loadNetworkStatus();
  loadEthernetConfig();
  loadWifiClientStatus();
  // Refresh every 30 s
  setInterval(loadWifiStatus,       30_000);
  setInterval(loadNetworkStatus,    30_000);
  setInterval(loadWifiClientStatus, 30_000);

})();

// ═══════════════════════════════════════════════════════════════
//  Auth — check session, populate header, handle logout
// ═══════════════════════════════════════════════════════════════
(async function initAuth() {
  let currentUser = null;

  // Check who is logged in
  try {
    const res  = await fetch("/api/auth/me");
    const data = await res.json();
    if (res.ok && data.user) {
      currentUser = data.user;
    } else {
      // Not authenticated — redirect to login (unless hotspot)
      window.location.href = "/login";
      return;
    }
  } catch (e) {
    window.location.href = "/login";
    return;
  }

  // Show username in header
  const headerUsername = document.getElementById("headerUsername");
  const headerUser     = document.getElementById("headerUser");
  if (headerUsername) {
    headerUsername.textContent = currentUser.hotspot
      ? "Hotspot Access"
      : `👤 ${currentUser.username}`;
  }
  if (headerUser) headerUser.style.display = "flex";

  // Logout button
  document.getElementById("logoutBtn")?.addEventListener("click", async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    window.location.href = "/login";
  });

  // Force-password-change banner — show it when forcePasswordChange is set and auto-open admin settings
  if (currentUser.forcePasswordChange && !currentUser.hotspot) {
    const banner = document.getElementById("forcePasswordBanner");
    if (banner) banner.style.display = "block";
    // Auto-open the Admin Settings card and the Change Password section
    const adminBody    = document.getElementById("adminSettingsBody");
    const adminChevron = document.getElementById("adminSettingsChevron");
    if (adminBody)    adminBody.style.display = "block";
    if (adminChevron) adminChevron.textContent = "▼";
    document.getElementById("changePasswordDetails")?.setAttribute("open", "");
  }

  // Show User Management + Remote Access sections for admins only
  if (currentUser.role === "admin" || currentUser.hotspot) {
    const sec = document.getElementById("userMgmtSection");
    if (sec) sec.style.display = "block";
    loadUserList();

    const remoteSec = document.getElementById("remoteAccessSection");
    if (remoteSec) remoteSec.style.display = "block";
    await initRegistration();   // sets deviceRegistered + gates start button
    initRemoteAccess();
    initRemoteSsh();
  }

  // ── Software version ─────────────────────────────────────────
  (async () => {
    try {
      const r = await fetch("/api/version");
      const d = await r.json();
      const el = document.getElementById("softwareVersion");
      if (el) el.textContent = `v${d.version}`;
    } catch { /* silently ignore */ }
  })();

  // ── Timezone ──────────────────────────────────────────────────
  (async () => {
    try {
      const r = await fetch("/api/timezone");
      const d = await r.json();
      if (!d.success) return;

      const currentEl = document.getElementById("currentTimezone");
      if (currentEl) currentEl.textContent = d.current || "—";

      const sel = document.getElementById("timezoneSelect");
      if (sel && d.timezones) {
        sel.innerHTML = (d.timezones)
          .map(tz => `<option value="${tz.value}"${tz.value === d.current ? " selected" : ""}>${tz.label}</option>`)
          .join("");
      }
    } catch { /* silently ignore */ }
  })();

  document.getElementById("saveTimezoneBtn")?.addEventListener("click", async () => {
    const msg = document.getElementById("timezoneMsg");
    const sel = document.getElementById("timezoneSelect");
    const tz  = sel?.value?.trim();
    if (!tz) { showMsg(msg, "❌ Please select a timezone", true); return; }
    try {
      const r = await fetch("/api/timezone", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ timezone: tz }),
      });
      const d = await r.json();
      if (d.success) {
        showMsg(msg, `✅ Timezone set to ${d.timezone}`);
        const currentEl = document.getElementById("currentTimezone");
        if (currentEl) currentEl.textContent = d.timezone;
      } else {
        showMsg(msg, `❌ ${d.error}`, true);
      }
    } catch (e) {
      showMsg(msg, `❌ ${e.message}`, true);
    }
  });

  // ── Power: restart software (any admin) ──────────────────────
  document.getElementById("restartSoftwareBtn")?.addEventListener("click", async () => {
    const btn = document.getElementById("restartSoftwareBtn");
    const msg = document.getElementById("restartSoftwareMsg");

    if (!confirm("Restart the camera software now?")) return;

    btn.disabled = true;
    btn.textContent = "⏳ Restarting…";
    msg.textContent = "🔄 Restarting service…";
    msg.style.color = "#facc15";

    try {
      await fetch("/api/restart", { method: "POST" });
    } catch { /* server already restarting */ }

    const poll = async () => {
      try {
        const pr = await fetch("/api/status");
        if (pr.ok) {
          msg.textContent = "✅ Restarted — reloading…";
          msg.style.color = "#4ade80";
          setTimeout(() => window.location.reload(), 1500);
          return;
        }
      } catch { /* still restarting */ }
      setTimeout(poll, 2000);
    };
    setTimeout(poll, 3000);
  });

  // ── Power: reboot device (any admin) ─────────────────────────
  document.getElementById("rebootSystemBtn")?.addEventListener("click", async () => {
    const btn = document.getElementById("rebootSystemBtn");
    const msg = document.getElementById("rebootSystemMsg");

    if (!confirm("Reboot the entire device? The camera will be offline for 30–60 seconds.")) return;

    btn.disabled = true;
    btn.textContent = "⏳ Rebooting…";
    msg.textContent = "🔄 Device is rebooting — reconnect in about 30–60 seconds…";
    msg.style.color = "#facc15";

    try {
      await fetch("/api/reboot", { method: "POST" });
    } catch { /* device already rebooting */ }

    // Reboot takes longer — wait 15s before starting to poll
    const poll = async () => {
      try {
        const pr = await fetch("/api/status");
        if (pr.ok) {
          msg.textContent = "✅ Device back online — reloading…";
          msg.style.color = "#4ade80";
          setTimeout(() => window.location.reload(), 1500);
          return;
        }
      } catch { /* still rebooting */ }
      setTimeout(poll, 3000);
    };
    setTimeout(poll, 15000);
  });

  // ── Software update (dpadmin only) ───────────────────────────
  if (currentUser.username !== "dpadmin") {
    document.getElementById("updateSoftwareBtn")?.closest("div")?.remove();
  }

  // Shared helper: POST /api/update, poll until server comes back, then reload.
  async function runUpdate(commit = "latest", labelForConfirm = "latest") {
    const msg    = document.getElementById("updateSoftwareMsg");
    const output = document.getElementById("updateSoftwareOutput");

    if (!confirm(`This will deploy version "${labelForConfirm}" and restart the camera service. Continue?`)) return false;

    msg.textContent = "";
    output.style.display = "none";

    const pollUntilBack = () => {
      const poll = async () => {
        try {
          const pr = await fetch("/api/status");
          if (pr.ok) {
            msg.textContent = "✅ Deploy complete — reloading…";
            msg.style.color = "#4ade80";
            setTimeout(() => window.location.reload(), 1500);
            return;
          }
        } catch { /* still restarting */ }
        setTimeout(poll, 2000);
      };
      setTimeout(poll, 3000);
    };

    try {
      const r = await fetch("/api/update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ commit }),
      });
      const d = await r.json();

      if (!d.success) {
        msg.textContent = `❌ ${d.error}`;
        msg.style.color = "#f87171";
        return false;
      }

      output.textContent = d.output;
      output.style.display = "block";
      msg.textContent = "🔄 Restarting service…";
      msg.style.color = "#facc15";
      pollUntilBack();
    } catch {
      // Server already restarted before it could respond — just poll
      msg.textContent = "🔄 Restarting service…";
      msg.style.color = "#facc15";
      pollUntilBack();
    }
    return true;
  }

  document.getElementById("updateSoftwareBtn")?.addEventListener("click", async () => {
    const btn = document.getElementById("updateSoftwareBtn");
    btn.disabled = true;
    btn.textContent = "⏳ Updating…";
    const ok = await runUpdate("latest", "latest (origin/main)");
    if (!ok) {
      btn.disabled = false;
      btn.textContent = "⬆️ Update to Latest";
    }
  });

  // ── Load version history ──────────────────────────────────────
  document.getElementById("loadCommitsBtn")?.addEventListener("click", async () => {
    const btn     = document.getElementById("loadCommitsBtn");
    const section = document.getElementById("commitListSection");
    const select  = document.getElementById("commitSelect");
    const msg     = document.getElementById("updateSoftwareMsg");

    btn.disabled = true;
    btn.textContent = "⏳ Loading…";
    msg.textContent = "";

    try {
      const r = await fetch("/api/commits");
      const d = await r.json();

      if (!d.success) {
        msg.textContent = `❌ ${d.error}`;
        msg.style.color = "#f87171";
        btn.disabled = false;
        btn.textContent = "📋 Load Version History";
        return;
      }

      select.innerHTML = "";
      d.commits.forEach(({ hash, date, subject }) => {
        const opt = document.createElement("option");
        opt.value = hash;
        const isCurrent = hash === d.current;
        opt.textContent = `${hash.slice(0, 8)}  ${date}  ${subject}${isCurrent ? "  ◀ current" : ""}`;
        if (isCurrent) opt.style.color = "#4ade80";
        select.appendChild(opt);
      });

      section.style.display = "block";
      btn.textContent = "🔄 Refresh Version History";
    } catch (e) {
      msg.textContent = `❌ ${e.message}`;
      msg.style.color = "#f87171";
      btn.textContent = "📋 Load Version History";
    }
    btn.disabled = false;
  });

  document.getElementById("deployCommitBtn")?.addEventListener("click", async () => {
    const btn    = document.getElementById("deployCommitBtn");
    const select = document.getElementById("commitSelect");
    const hash   = select?.value;
    if (!hash) return;

    const label = select.options[select.selectedIndex]?.textContent || hash.slice(0, 8);
    btn.disabled = true;
    btn.textContent = "⏳ Deploying…";
    const ok = await runUpdate(hash, label);
    if (!ok) {
      btn.disabled = false;
      btn.textContent = "🚀 Deploy Selected Version";
    }
  });

  // ── helper: show a temporary status message ─────────────────
  function showMsg(el, text, isError = false) {
    if (!el) return;
    el.textContent = text;
    el.style.color = isError ? "#f87171" : "#4ade80";
    setTimeout(() => { el.textContent = ""; }, 5000);
  }

  // ── Change own password ──────────────────────────────────────
  document.getElementById("changePasswordBtn")?.addEventListener("click", async () => {
    const msg     = document.getElementById("changePasswordMsg");
    const oldPw   = document.getElementById("oldPassword")?.value;
    const newPw   = document.getElementById("newPassword")?.value;
    const confirm = document.getElementById("confirmPassword")?.value;

    if (!newPw || newPw.length < 8) { showMsg(msg, "Password must be at least 8 characters", true); return; }
    if (newPw !== confirm)           { showMsg(msg, "Passwords do not match", true); return; }

    try {
      const r = await fetch(`/api/users/${currentUser.username}/password`, {
        method:  "PUT",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ oldPassword: oldPw, newPassword: newPw }),
      });
      const d = await r.json();
      if (d.success) {
        showMsg(msg, "✅ Password changed successfully");
        document.getElementById("oldPassword").value     = "";
        document.getElementById("newPassword").value     = "";
        document.getElementById("confirmPassword").value = "";
        document.getElementById("changePasswordDetails")?.removeAttribute("open");
        const banner = document.getElementById("forcePasswordBanner");
        if (banner) banner.style.display = "none";
      } else {
        showMsg(msg, `❌ ${d.error}`, true);
      }
    } catch (e) {
      showMsg(msg, `❌ ${e.message}`, true);
    }
  });

  // ── User management (admin only) ─────────────────────────────
  async function loadUserList() {
    const container = document.getElementById("userList");
    if (!container) return;
    try {
      const r    = await fetch("/api/users");
      const data = await r.json();
      container.innerHTML = "";
      (data.users || []).forEach(u => {
        const row = document.createElement("div");
        row.className = "user-row";
        row.innerHTML = `
          <span class="user-row-name">${u.username}</span>
          <span class="user-row-role ${u.role}">${u.role}</span>
          ${u.username === currentUser.username
            ? `<span class="user-row-you">(you)</span>`
            : (u.locked || u.username === "admin")
              ? `<span class="user-row-locked" title="Built-in account — cannot be deleted or modified">🔒</span>`
              : `<button class="btn-user-delete" data-user="${u.username}" title="Delete user">🗑</button>`}
        `;
        container.appendChild(row);
      });
      // Bind delete buttons
      container.querySelectorAll(".btn-user-delete").forEach(btn => {
        btn.addEventListener("click", async () => {
          if (!confirm(`Delete user "${btn.dataset.user}"?`)) return;
          const r = await fetch(`/api/users/${btn.dataset.user}`, { method: "DELETE" });
          const d = await r.json();
          if (d.success) loadUserList();
          else alert(d.error);
        });
      });
    } catch (e) {
      container.innerHTML = `<div style="color:#fca5a5;font-size:12px">Failed to load users: ${e.message}</div>`;
    }
  }

  document.getElementById("addUserBtn")?.addEventListener("click", async () => {
    const msg  = document.getElementById("addUserMsg");
    const body = {
      username: document.getElementById("newUserUsername")?.value.trim(),
      password: document.getElementById("newUserPassword")?.value,
      role:     document.getElementById("newUserRole")?.value,
    };
    if (!body.username) { showMsg(msg, "Username is required", true); return; }
    if (!body.password || body.password.length < 8) { showMsg(msg, "Password must be 8+ characters", true); return; }
    try {
      const r = await fetch("/api/users", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(body),
      });
      const d = await r.json();
      if (d.success) {
        showMsg(msg, `✅ User "${d.user.username}" added`);
        document.getElementById("newUserUsername").value = "";
        document.getElementById("newUserPassword").value = "";
        document.getElementById("addUserDetails")?.removeAttribute("open");
        loadUserList();
      } else {
        showMsg(msg, `❌ ${d.error}`, true);
      }
    } catch (e) {
      showMsg(msg, `❌ ${e.message}`, true);
    }
  });

  // ── Device Registration ──────────────────────────────────────
  async function initRegistration() {
    const noInternetArea = document.getElementById("regNoInternetArea");
    const formArea       = document.getElementById("regFormArea");
    const statusArea     = document.getElementById("regStatusArea");
    const nameInput      = document.getElementById("regDeviceName");
    const emailInput     = document.getElementById("regOwnerEmail");
    const registerBtn    = document.getElementById("registerDeviceBtn");
    const regMsg         = document.getElementById("regMsg");
    const regCheckMsg    = document.getElementById("regCheckMsg");
    const regStatusName  = document.getElementById("regStatusName");
    const regStatusEmail = document.getElementById("regStatusEmail");
    const regStatusDate  = document.getElementById("regStatusDate");
    const regStatusIp    = document.getElementById("regStatusIp");
    const regBadge       = document.getElementById("regRequiredBadge");
    const regDetails     = document.getElementById("registrationDetails");
    let   noInternetPoll = null;  // interval handle for auto-retry

    function showRegMsg(text, isError = false) {
      if (!regMsg) return;
      regMsg.textContent = text;
      regMsg.style.color = isError ? "#f87171" : "#4ade80";
      if (!isError) setTimeout(() => { regMsg.textContent = ""; }, 6000);
    }

    function showRegistered(data) {
      deviceRegistered = true;
      clearInterval(noInternetPoll);
      if (noInternetArea) noInternetArea.style.display = "none";
      if (formArea)       formArea.style.display       = "none";
      if (statusArea)     statusArea.style.display     = "";
      if (regStatusName)  regStatusName.textContent    = data.deviceName  || "—";
      if (regStatusEmail) regStatusEmail.textContent   = data.ownerEmail  || "—";
      if (regStatusDate && data.registeredAt)
        regStatusDate.textContent = new Date(data.registeredAt).toLocaleDateString();
      if (regStatusIp) regStatusIp.textContent = data.netbirdIp || data.ip || "—";
      if (regBadge) regBadge.style.display = "none";
      if (startStreamBtn && startStreamBtn.disabled) startStreamBtn.disabled = false;
    }

    function showUnregistered(hasInternet) {
      deviceRegistered = false;
      if (statusArea) statusArea.style.display = "none";
      if (regBadge)   regBadge.style.display   = "";
      if (regDetails && !regDetails.open) regDetails.open = true;
      if (startStreamBtn) startStreamBtn.disabled = true;

      if (hasInternet) {
        // Internet available — show the registration form
        clearInterval(noInternetPoll);
        if (noInternetArea) noInternetArea.style.display = "none";
        if (formArea)       formArea.style.display       = "";
      } else {
        // No internet — hide the form, show the blocker
        if (formArea)       formArea.style.display       = "none";
        if (noInternetArea) noInternetArea.style.display = "";
        // Auto-poll every 15 s so the section unlocks as soon as network comes up
        if (!noInternetPoll) {
          noInternetPoll = setInterval(async () => {
            try {
              const r = await fetch("/api/setup/status");
              const d = await r.json();
              if (d.registered) {
                clearInterval(noInternetPoll); noInternetPoll = null;
                showRegistered(d);
              } else if (d.hasInternet) {
                clearInterval(noInternetPoll); noInternetPoll = null;
                showUnregistered(true);
              }
            } catch { /* ignore — keep polling */ }
          }, 15000);
        }
      }
    }

    // Fetch current registration state
    try {
      const r = await fetch("/api/setup/status");
      const d = await r.json();
      if (d.registered) {
        showRegistered(d);
        // Pre-fill name input for re-register flow
        if (nameInput  && d.deviceName)  nameInput.value  = d.deviceName;
        if (emailInput && d.ownerEmail)  emailInput.value = d.ownerEmail;
      } else {
        showUnregistered(d.hasInternet);
      }
    } catch {
      showUnregistered(false);
    }

    // "Go to Network Settings" — open the Network accordion and scroll to it
    document.getElementById("regGoToNetworkBtn")?.addEventListener("click", () => {
      const networkDetails = document.querySelector(".admin-collapsible[data-section='network'], #networkDetails, details.admin-collapsible");
      // Find the Network Settings <details> by looking for its summary text
      const allDetails = document.querySelectorAll("details.admin-collapsible");
      for (const d of allDetails) {
        const summary = d.querySelector("summary");
        if (summary && summary.textContent.toLowerCase().includes("network")) {
          d.open = true;
          d.scrollIntoView({ behavior: "smooth", block: "start" });
          return;
        }
      }
      // Fallback: just open the admin settings card if it's collapsed
      const adminBody = document.getElementById("adminSettingsBody");
      if (adminBody && adminBody.style.display === "none") {
        document.getElementById("adminSettingsToggle")?.click();
      }
    });

    // "Check Again" — re-probe internet and update the UI
    document.getElementById("regCheckAgainBtn")?.addEventListener("click", async () => {
      const btn = document.getElementById("regCheckAgainBtn");
      if (btn) btn.disabled = true;
      if (regCheckMsg) { regCheckMsg.textContent = "⏳ Checking…"; regCheckMsg.style.color = ""; }
      try {
        const r = await fetch("/api/setup/status");
        const d = await r.json();
        if (d.registered) {
          showRegistered(d);
        } else if (d.hasInternet) {
          showUnregistered(true);
        } else {
          if (regCheckMsg) { regCheckMsg.textContent = "Still no internet connection."; regCheckMsg.style.color = "#f87171"; }
        }
      } catch {
        if (regCheckMsg) { regCheckMsg.textContent = "Could not reach server."; regCheckMsg.style.color = "#f87171"; }
      } finally {
        if (btn) btn.disabled = false;
      }
    });

    // Register button
    registerBtn?.addEventListener("click", async () => {
      const name  = nameInput?.value.trim();
      const email = emailInput?.value.trim();
      if (!name)  { showRegMsg("❌ Device name is required", true); return; }
      if (!email) { showRegMsg("❌ Owner email is required", true); return; }
      showRegMsg("⏳ Registering… this may take up to 30 s");
      registerBtn.disabled = true;
      try {
        const r = await fetch("/api/setup/register", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ deviceName: name, ownerEmail: email }),
        });
        const d = await r.json();
        if (d.success) {
          showRegMsg(`✅ Registered — NetBird IP: ${d.ip}`);
          showRegistered(d);
          // Also refresh NetBird connection status in the lower panel
          refreshNetbirdStatus?.();
        } else {
          showRegMsg(`❌ ${d.error}`, true);
          registerBtn.disabled = false;
        }
      } catch (e) {
        showRegMsg(`❌ ${e.message}`, true);
        registerBtn.disabled = false;
      }
    });

    // Re-register button: wipe identity, show the form again with existing values
    const reregBtn = document.getElementById("remoteReregisterBtn");
    reregBtn?.addEventListener("click", async () => {
      const currentName  = document.getElementById("regStatusName")?.textContent  || "";
      const currentEmail = document.getElementById("regStatusEmail")?.textContent || "";
      if (!confirm(
        `De-register this device?\n\n` +
        `This removes it from the VPN and clears its registration. ` +
        `You will need to re-register before streaming can resume.`
      )) return;

      const msg = document.getElementById("remoteMsg");
      const showMsg = (t, isError = false) => {
        if (!msg) return;
        msg.textContent = t;
        msg.style.color = isError ? "#f87171" : "#4ade80";
      };

      showMsg("⏳ Removing peer from NetBird server and wiping local identity…");
      reregBtn.disabled = true;

      try {
        // /api/remote/wipe: deletes the peer from the NetBird server (if
        // NETBIRD_API_TOKEN is set) AND wipes /var/lib/netbird/ locally.
        // It does NOT run netbird up — that is handled by /api/setup/register
        // when the user submits the form below.
        const r = await fetch("/api/remote/wipe", { method: "POST" });
        const d = await r.json();
        if (d.success) {
          showMsg("✅ Old peer removed. Enter new details below and click Register.");
        } else {
          showMsg(`❌ Wipe failed: ${d.error}`, true);
          reregBtn.disabled = false;
          return;
        }
      } catch (e) {
        showMsg(`❌ ${e.message}`, true);
        reregBtn.disabled = false;
        return;
      }

      // Show the registration form with existing values pre-filled
      deviceRegistered = false;
      if (startStreamBtn) startStreamBtn.disabled = true;
      if (formArea)   formArea.style.display  = "";
      if (statusArea) statusArea.style.display = "none";
      if (nameInput  && currentName)  nameInput.value  = currentName;
      if (emailInput && currentEmail) emailInput.value = currentEmail;
      reregBtn.disabled = false;
    });
  }

  // ── Remote Access (NetBird) — connection status panel ────────
  function initRemoteAccess() {
    const statusDot  = document.getElementById("remoteStatusDot");
    const statusText = document.getElementById("remoteStatusText");
    const ipRow      = document.getElementById("remoteIpRow");
    const ipValue    = document.getElementById("remoteIpValue");

    function setConnected(ip) {
      if (statusDot)  statusDot.className    = "remote-status-dot remote-dot-on";
      if (statusText) statusText.textContent = "Connected to DigitalPool VPN";
      if (ipRow)      ipRow.style.display    = "flex";
      if (ipValue)    ipValue.textContent    = ip;
    }

    function setDisconnected() {
      if (statusDot)  statusDot.className    = "remote-status-dot remote-dot-off";
      if (statusText) statusText.textContent = "Not connected";
      if (ipRow)      ipRow.style.display    = "none";
    }

    async function refreshStatus() {
      try {
        const r = await fetch("/api/remote/status");
        const d = await r.json();
        if (d.enabled && d.ip) setConnected(d.ip);
        else setDisconnected();
      } catch { setDisconnected(); }
    }
    // Expose so initRegistration can trigger a refresh after registering
    window.refreshNetbirdStatus = refreshStatus;

    refreshStatus();
  }

  // ── NetBird SSH (dpadmin only) ───────────────────────────────
  async function initRemoteSsh() {
    const block      = document.getElementById("remoteSshBlock");
    const dot        = document.getElementById("remoteSshDot");
    const text       = document.getElementById("remoteSshText");
    const hintRow    = document.getElementById("remoteSshHintRow");
    const hint       = document.getElementById("remoteSshHint");
    const enableBtn  = document.getElementById("remoteSshEnableBtn");
    const disableBtn = document.getElementById("remoteSshDisableBtn");
    const msg        = document.getElementById("remoteSshMsg");
    if (!block || !enableBtn || !disableBtn) return;

    function showMsg(el, t, isError = false) {
      if (!el) return;
      el.textContent = t;
      el.style.color = isError ? "#f87171" : "#4ade80";
      setTimeout(() => { el.textContent = ""; }, 5000);
    }

    function render(d) {
      if (!d.canToggleSsh && !d.isDpAdmin) { block.style.display = "none"; return; }
      block.style.display = "block";
      if (d.active) {
        dot.className = "remote-status-dot remote-dot-on";
        text.textContent = "SSH: enabled";
        enableBtn.style.display  = "none";
        disableBtn.style.display = "";
        if (d.ip) {
          hint.textContent = `ssh ubuntu@${d.ip}`;
          hintRow.style.display = "flex";
        } else {
          hintRow.style.display = "none";
        }
      } else {
        dot.className = "remote-status-dot remote-dot-off";
        text.textContent = "SSH: disabled";
        hintRow.style.display = "none";
        enableBtn.style.display  = "";
        disableBtn.style.display = "none";
      }
    }

    async function refresh() {
      try {
        const r = await fetch("/api/remote/ssh/status");
        if (!r.ok) { block.style.display = "none"; return; }
        render(await r.json());
      } catch { block.style.display = "none"; }
    }

    enableBtn.addEventListener("click", async () => {
      showMsg(msg, "⏳ Enabling SSH…");
      enableBtn.disabled = true;
      try {
        const r = await fetch("/api/remote/ssh/enable", { method: "POST" });
        const d = await r.json();
        if (d.success) { showMsg(msg, "✅ SSH enabled"); await refresh(); }
        else showMsg(msg, `❌ ${d.error}`, true);
      } catch (e) { showMsg(msg, `❌ ${e.message}`, true); }
      finally { enableBtn.disabled = false; }
    });

    disableBtn.addEventListener("click", async () => {
      showMsg(msg, "⏳ Disabling SSH…");
      disableBtn.disabled = true;
      try {
        const r = await fetch("/api/remote/ssh/disable", { method: "POST" });
        const d = await r.json();
        if (d.success) { showMsg(msg, "✅ SSH disabled"); await refresh(); }
        else showMsg(msg, `❌ ${d.error}`, true);
      } catch (e) { showMsg(msg, `❌ ${e.message}`, true); }
      finally { disableBtn.disabled = false; }
    });

    await refresh();
  }

})();

// ═══════════════════════════════════════════════════════════════
//  Collapsible Settings Cards (PTZ, Overlay, Camera Settings, Stream Server)
// ═══════════════════════════════════════════════════════════════
(function initSettingsCards() {
  const cards = [
    { toggleId: "ptzToggle",            bodyId: "ptzBody",            chevronId: "ptzChevron" },
    { toggleId: "overlayToggle",        bodyId: "overlayBody",        chevronId: "overlayChevron" },
    { toggleId: "cameraSettingsToggle", bodyId: "cameraSettingsBody", chevronId: "cameraSettingsChevron" },
    { toggleId: "streamServerToggle",   bodyId: "streamServerBody",   chevronId: "streamServerChevron" },
    { toggleId: "adminSettingsToggle",  bodyId: "adminSettingsBody",  chevronId: "adminSettingsChevron" },
  ];

  cards.forEach(({ toggleId, bodyId, chevronId }) => {
    const toggleEl  = document.getElementById(toggleId);
    const bodyEl    = document.getElementById(bodyId);
    const chevronEl = document.getElementById(chevronId);
    if (!toggleEl || !bodyEl) return;

    // Start collapsed
    bodyEl.style.display = "none";
    if (chevronEl) chevronEl.textContent = "▶";

    toggleEl.addEventListener("click", () => {
      const isOpen = bodyEl.style.display !== "none";
      bodyEl.style.display = isOpen ? "none" : "block";
      if (chevronEl) chevronEl.textContent = isOpen ? "▶" : "▼";
    });
  });
})();


// ── Low Bandwidth Mode — snapshot polling toggle ───────────────────────────
(function () {
  const checkbox = document.getElementById("lowBandwidthMode");
  const intervalSel = document.getElementById("snapshotInterval");
  if (!checkbox || !intervalSel) return;

  // Restore saved preferences
  const savedMode = localStorage.getItem("lowBandwidthMode") === "true";
  const savedInterval = localStorage.getItem("snapshotInterval");
  if (savedInterval) intervalSel.value = savedInterval;
  if (savedMode) {
    lowBandwidthMode = true;
    checkbox.checked = true;
  }

  checkbox.addEventListener("change", () => {
    lowBandwidthMode = checkbox.checked;
    localStorage.setItem("lowBandwidthMode", lowBandwidthMode);

    // Switch the live preview immediately to reflect the new mode
    if (lowBandwidthMode) {
      switchToSnapshotPreview();
    } else {
      // Restore the WebRTC preview for the active camera
      const _restorePath = activeCamIndex === 2 ? "preview2" : "preview";
      switchToWebRTCPreview(_restorePath);
    }
  });

  intervalSel.addEventListener("change", () => {
    localStorage.setItem("snapshotInterval", intervalSel.value);
    // Restart snapshot polling immediately with the new interval if active
    if (lowBandwidthMode && _snapshotPollActive) {
      switchToSnapshotPreview();
    }
  });
})();
