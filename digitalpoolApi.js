// Transport for the DigitalPool Firebase Cloud Functions this device talks to.
//
// There is no Firebase SDK and no API key on the device — every call is a plain
// HTTPS POST of a JSON `action` to a function URL, and the function does all of
// the authentication server-side.  Two callers share this:
//
//   • registration        (server.js — actions verify / assign / deregister)
//   • subscription checks (subscriptionManager.js — action subscription)
//
// Resolves to { statusCode, body } where `body` is the parsed JSON response
// ({ raw } when the response was not JSON).  Rejects only on transport errors
// (DNS, connection, timeout) — an HTTP error status resolves normally so the
// caller can tell "the service said no" from "we could not reach the service".
const { URL } = require("url");

const DEFAULT_BASE = "https://us-central1-digital-pool.cloudfunctions.net";

/** Base URL of the DigitalPool cloud functions (no trailing slash). */
function functionsBase() {
  return (process.env.DIGITALPOOL_FUNCTIONS_URL || DEFAULT_BASE).replace(/\/$/, "");
}

function callDigitalPoolFunction(fnName, payload, { timeout = 20000 } = {}) {
  const fullUrl = `${functionsBase()}/${fnName}`;
  const urlObj  = new URL(fullUrl);
  const mod     = fullUrl.startsWith("https") ? require("https") : require("http");
  const reqBody = JSON.stringify(payload);

  return new Promise((resolve, reject) => {
    const options = {
      hostname: urlObj.hostname,
      port:     urlObj.port || (fullUrl.startsWith("https") ? 443 : 80),
      path:     urlObj.pathname + urlObj.search,
      method:   "POST",
      headers: {
        "Content-Type":   "application/json",
        Accept:           "application/json",
        "Content-Length": Buffer.byteLength(reqBody),
      },
      timeout,
    };
    const req = mod.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        let body = {};
        try { body = data ? JSON.parse(data) : {}; } catch { body = { raw: data }; }
        resolve({ statusCode: res.statusCode, body });
      });
    });
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error(`DigitalPool ${fnName} request timed out`));
    });
    req.write(reqBody);
    req.end();
  });
}

module.exports = { callDigitalPoolFunction, functionsBase };
