/**
 * cameraDevices.js — discover USB video capture devices by stable identity.
 *
 * Why this module exists
 * ----------------------
 * `/dev/videoN` numbering is not stable. Any uvcvideo re-probe — `usb-reset.sh`,
 * USB autosuspend, a driver rebind — reassigns the numbers, with no USB
 * disconnect and no other visible symptom. Observed on dp-stream-2e27: a camera
 * moved from `/dev/video0` to `/dev/video1` while never leaving the bus, and
 * everything pinned to `/dev/video0` (the `.env` value, the persisted camera
 * source) pointed at nothing. Cam1 was down for two days.
 *
 * Two further traps this module exists to close:
 *
 *   1. Every UVC camera exposes a SECOND node beside its capture node, for
 *      metadata. It cannot stream. `v4l2-ctl --list-devices` lists both without
 *      distinguishing them, so a naive device picker offers twice as many
 *      cameras as exist and half of them fail.
 *   2. udev already maintains stable symlinks under `/dev/v4l/by-id/` keyed on
 *      the camera's USB serial. Anything that stores a device path should store
 *      one of those, never a `/dev/videoN`.
 *
 * Everything here works off whatever is plugged in right now — no per-device
 * configuration, any number of cameras, any ports.
 */

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const BY_ID_DIR = "/dev/v4l/by-id";

/**
 * Parse `udevadm info --query=property` output into a plain object.
 * Pure — the IO lives in _readProperties.
 */
function parseUdevProperties(text) {
  const props = {};
  for (const line of String(text).split("\n")) {
    const eq = line.indexOf("=");
    if (eq > 0) props[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return props;
}

/**
 * Can this node actually deliver video?
 *
 * udev's own `v4l_id` helper sets ID_V4L_CAPABILITIES from VIDIOC_QUERYCAP;
 * `:capture:` appears only for V4L2_CAP_VIDEO_CAPTURE. A UVC metadata node
 * reports V4L2_CAP_META_CAPTURE instead, so it is excluded here.
 *
 * When the property is missing entirely (v4l_id absent or it failed) we do NOT
 * guess — an unknown node is reported as non-capture, because offering a
 * metadata node as a camera produces a stream that fails at S_FMT with no
 * useful error.
 */
function isCaptureNode(props) {
  return String(props.ID_V4L_CAPABILITIES || "").includes(":capture:");
}

/** True for a path that survives renumbering; false for a bare /dev/videoN. */
function isStablePath(device) {
  return typeof device === "string" && device.startsWith("/dev/v4l/");
}

/**
 * Build node → stable-symlink map from the by-id directory.
 * Prefers by-id (keyed on serial, follows the camera) and never returns
 * by-path (keyed on the USB port, which is a different guarantee).
 */
function _readByIdLinks() {
  const map = new Map();
  let names;
  try {
    names = fs.readdirSync(BY_ID_DIR);
  } catch (_) {
    return map; // no by-id dir on this image — callers fall back to raw nodes
  }
  for (const name of names) {
    const link = path.join(BY_ID_DIR, name);
    try {
      const target = fs.realpathSync(link);
      // First link wins: udev may emit several aliases for one node and they
      // are equivalent, so the choice only needs to be deterministic.
      if (!map.has(target)) map.set(target, link);
    } catch (_) { /* dangling symlink — the device went away mid-scan */ }
  }
  return map;
}

function _readProperties(node) {
  try {
    return parseUdevProperties(
      execFileSync("udevadm", ["info", "--query=property", "--name", node], {
        encoding: "utf8",
        timeout: 3000,
        stdio: ["ignore", "pipe", "ignore"],
      })
    );
  } catch (_) {
    return null;
  }
}

/**
 * Every USB video capture device present right now.
 *
 * Sorted by USB port path so the order is deterministic across reboots and
 * re-probes: the camera in the lowest-numbered port is always first. That makes
 * slot assignment reproducible without storing anything per device.
 *
 * @returns {Array<{device: string, node: string, name: string, serial: string,
 *                  portPath: string, stable: boolean}>}
 *   `device` is what callers should use and persist — the by-id path when udev
 *   provides one, else the raw node as a last resort (marked `stable: false`).
 */
function listCaptureCameras() {
  let nodes;
  try {
    nodes = fs
      .readdirSync("/dev")
      .filter((n) => /^video\d+$/.test(n))
      .map((n) => `/dev/${n}`);
  } catch (_) {
    return [];
  }

  const byId = _readByIdLinks();
  const cameras = [];

  for (const node of nodes) {
    const props = _readProperties(node);
    if (!props || !isCaptureNode(props)) continue;

    // Non-USB capture hardware (a PCI capture card, a loopback device) has no
    // USB serial and is not what this appliance drives.
    if (String(props.ID_BUS || "") !== "usb") continue;

    const stablePath = byId.get(node) || null;
    cameras.push({
      device: stablePath || node,
      node,
      name: props.ID_V4L_PRODUCT || props.ID_MODEL_FROM_DATABASE || "USB camera",
      serial: props.ID_SERIAL_SHORT || "",
      portPath: props.ID_PATH || "",
      stable: Boolean(stablePath),
    });
  }

  cameras.sort(comparePortPaths);
  return cameras;
}

/**
 * Order two cameras by physical USB port, numerically.
 *
 * ID_PATH looks like `pci-0000:00:14.0-usb-0:1.1:1.0`, where the middle
 * colon-separated field (`1.1`) is the port chain: root port, then each hub
 * port below it. Comparing those as strings is wrong twice over — `1.10` sorts
 * before `1.2` lexically, and localeCompare's ordering of `.` versus `:`
 * depends on the runtime locale — so the chain is compared as a list of
 * integers, with a shorter chain (a camera on a root port) ahead of a longer
 * one (a camera behind a hub on that same port).
 */
function _portChain(idPath) {
  const m = String(idPath || "").match(/-usb-\d+:([\d.]+):/);
  if (!m) return null;
  return m[1].split(".").map((n) => parseInt(n, 10));
}

function comparePortPaths(a, b) {
  const ca = _portChain(a.portPath);
  const cb = _portChain(b.portPath);

  // An unparseable ID_PATH sorts last rather than scrambling the known-good
  // ordering, and ties break on the node name so the result is total.
  if (!ca && !cb) return a.node < b.node ? -1 : a.node > b.node ? 1 : 0;
  if (!ca) return 1;
  if (!cb) return -1;

  for (let i = 0; i < Math.max(ca.length, cb.length); i++) {
    const x = ca[i], y = cb[i];
    if (x === undefined) return -1; // shorter chain = closer to the root port
    if (y === undefined) return 1;
    if (x !== y) return x - y;
  }
  return a.node < b.node ? -1 : a.node > b.node ? 1 : 0;
}

/**
 * Resolve any device path to its stable equivalent.
 *
 * Used to heal configuration that was written before this module existed: a
 * persisted `/dev/video0` becomes the by-id path for whatever camera is on that
 * node now. Returns the input unchanged when it is already stable, or when the
 * node is not currently a capture device (in which case there is nothing
 * truthful to map it to).
 */
function toStablePath(device) {
  if (!device || isStablePath(device)) return device;
  const match = listCaptureCameras().find((c) => c.node === device);
  return match ? match.device : device;
}

/**
 * The device a camera slot should use when nothing has been configured.
 * Slot 1 takes the first discovered camera, slot 2 the second.
 * Returns null when that many cameras are not present.
 */
function defaultDeviceForSlot(slotIdx) {
  const cameras = listCaptureCameras();
  const picked = cameras[(slotIdx === 2 ? 2 : 1) - 1];
  return picked ? picked.device : null;
}

module.exports = {
  listCaptureCameras,
  toStablePath,
  defaultDeviceForSlot,
  isStablePath,
  // exported for testing
  parseUdevProperties,
  isCaptureNode,
  comparePortPaths,
};
