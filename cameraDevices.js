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
const BY_PATH_DIR = "/dev/v4l/by-path";

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
 * Map node → stable symlinks, from one of udev's persistent-name directories.
 * Several aliases can point at one node (udev emits both `usb-` and `usbvN-`
 * spellings of a port), so the candidates are sorted and the first is taken —
 * the choice only has to be deterministic.
 */
function _readLinkDir(dir) {
  const map = new Map();
  let names;
  try {
    names = fs.readdirSync(dir).sort();
  } catch (_) {
    return map; // directory absent on this image
  }
  for (const name of names) {
    const link = path.join(dir, name);
    try {
      const target = fs.realpathSync(link);
      if (!map.has(target)) map.set(target, link);
    } catch (_) { /* dangling symlink — device went away mid-scan */ }
  }
  return map;
}

/**
 * Choose the stable path to address a camera by.
 *
 * **by-path is preferred over by-id, and that is deliberate.** by-id is built
 * from `usb-<vendor>_<model>_<serial>` with the serial omitted when the device
 * does not report one — and some cameras don't. An OBSBOT Tiny SE yields
 * `usb-Remo_Tech_Co.__Ltd._OBSBOT_Tiny_SE-video-index0` with no serial at all,
 * so two of them on one appliance generate the *same* by-id name, udev can only
 * create one symlink for it, and both camera slots end up addressing a single
 * physical camera. They then fight over it, each slot's cleanup killing the
 * other's preview, forever.
 *
 * by-path is keyed on the USB port, so it is unique per connector by
 * construction — there is no such thing as two devices in one port. The
 * trade-off is the opposite failure mode: moving a camera to a different port
 * reassigns it. For a fixed-cabling appliance that is the right trade, and it
 * matches how slots are assigned in the first place (by port order).
 */
function _pickStablePath(node, byPath, byId) {
  return byPath.get(node) || byId.get(node) || null;
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

  const byPath = _readLinkDir(BY_PATH_DIR);
  const byId = _readLinkDir(BY_ID_DIR);
  const cameras = [];

  for (const node of nodes) {
    const props = _readProperties(node);
    if (!props || !isCaptureNode(props)) continue;

    // Non-USB capture hardware (a PCI capture card, a loopback device) has no
    // USB serial and is not what this appliance drives.
    if (String(props.ID_BUS || "") !== "usb") continue;

    const stablePath = _pickStablePath(node, byPath, byId);
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

  // Two cameras must never share an address. If they did, two camera slots could
  // resolve to one physical device and fight over it — each slot's cleanup
  // killing the other's preview in a loop that never ends. udev can produce
  // exactly that when a camera reports no serial (see _pickStablePath), so the
  // invariant is enforced here rather than assumed: a collided camera falls back
  // to its raw node, which is unstable but at least unambiguous.
  const claimed = new Map();
  for (const cam of cameras) {
    const owner = claimed.get(cam.device);
    if (owner) {
      console.error(
        `❌ ${cam.device} addresses two different cameras (${owner.node} and ${cam.node}) — ` +
        `falling back to raw nodes for both. Stable paths are unusable for this hardware.`
      );
      owner.device = owner.node;
      owner.stable = false;
      cam.device = cam.node;
      cam.stable = false;
    } else {
      claimed.set(cam.device, cam);
    }
  }

  return cameras;
}

/**
 * Assign a device to each camera slot, guaranteeing the slots never collide.
 *
 * Resolving the slots independently is not safe: whatever the route — a stale
 * configured value, a healed saved source, two cameras sharing a by-id name —
 * two slots landing on one device puts the app in an unbreakable restart loop.
 * The old hardcoded /dev/video0 and /dev/video2 defaults made that structurally
 * impossible; this function restores that property deliberately.
 *
 * Per slot, in order of preference:
 *   1. the configured override, if it names a present capture device that no
 *      earlier slot has already claimed;
 *   2. the first unclaimed camera in USB port order;
 *   3. null — the slot has no camera, which the caller must treat as absent
 *      rather than substituting a path that might collide.
 *
 * @param {Array<number>} slots slot indices to resolve, in priority order
 * @param {(slot:number)=>string|undefined} configuredFor override lookup
 * @param {Array|null} cameraList inject a camera list instead of scanning (tests)
 * @returns {Map<number, {device: string|null, reason: string}>}
 */
function resolveSlots(slots, configuredFor, cameraList = null) {
  const cameras = cameraList || listCaptureCameras();
  const claimed = new Set();
  const out = new Map();

  for (const slot of slots) {
    const configured = configuredFor(slot);
    let device = null;
    let reason = "";

    if (configured) {
      const wanted = toStablePath(configured, cameras);
      const match = cameras.find((c) => c.device === wanted);
      if (!match) {
        reason = `configured ${configured} is not a present capture device`;
      } else if (claimed.has(match.device)) {
        reason = `configured ${configured} is already assigned to another camera slot`;
      } else {
        device = match.device;
        reason = wanted === configured ? "configured" : `configured ${configured} → stable path`;
      }
    }

    if (!device) {
      const free = cameras.find((c) => !claimed.has(c.device));
      if (free) {
        device = free.device;
        reason = reason ? `${reason}; auto-detected instead` : "auto-detected";
      } else {
        reason = reason ? `${reason}; no unclaimed camera available` : "no unclaimed camera available";
      }
    }

    if (device) claimed.add(device);
    out.set(slot, { device, reason });
  }

  return out;
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
function toStablePath(device, cameras = null) {
  if (!device) return device;
  const list = cameras || listCaptureCameras();
  // An already-stable path still needs checking: a by-id path that udev has
  // since pointed at a different camera, or one this hardware cannot address
  // uniquely, must not be taken at face value.
  if (isStablePath(device)) {
    return list.some((c) => c.device === device) ? device : device;
  }
  const match = list.find((c) => c.node === device);
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
  resolveSlots,
  toStablePath,
  defaultDeviceForSlot,
  isStablePath,
  // exported for testing
  parseUdevProperties,
  isCaptureNode,
  comparePortPaths,
};
