// Where the reference implementation lives.
//
// The harness scores this repo's renderer against the REAL overlay-builder
// components, so everything depends on this path pointing at the checkout the
// website is actually built from. It was hardcoded in four separate files and
// went stale: on 2026-11-12 it still named a checkout from October, which has
// none of the November element types. Running the gate against that would have
// reported conformance while every new type was missing — the harness would
// have been measuring the wrong thing and saying "pass".
//
// So: one definition, overridable, and a check that the reference is not stale.
// Override with DP_ANTD=/path/to/digitalpool-antd when working from a
// different checkout.
import fs from 'node:fs';
import path from 'node:path';

const CANDIDATES = [
  process.env.DP_ANTD,
  '/Users/timtraver/Projects/current_master/digitalpool-antd',
  '/Users/timtraver/Projects/digitalpool-antd',
].filter(Boolean);

function overlayBuilderOf(repo) {
  return path.join(repo, 'src', 'screens', 'overlay-builder');
}

export const ANTD = CANDIDATES.find(
  (repo) => fs.existsSync(overlayBuilderOf(repo))
) || CANDIDATES[CANDIDATES.length - 1];

/**
 * Refuse to score against a reference that predates the work being ported.
 *
 * `markers` are strings that must appear somewhere in the overlay-builder
 * sources. A missing one means this checkout is behind, and a silent pass
 * against a stale reference is worse than no gate at all.
 */
export function assertReferenceIsCurrent(markers = ['player_country_code', 'match_countdown', 'break_indicator']) {
  const dir = overlayBuilderOf(ANTD);
  if (!fs.existsSync(dir)) {
    throw new Error(`No overlay-builder at ${dir}. Set DP_ANTD to a digitalpool-antd checkout.`);
  }
  const haystack = [];
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(js|jsx)$/.test(entry.name)) haystack.push(fs.readFileSync(full, 'utf8'));
    }
  };
  walk(dir);
  const blob = haystack.join('\n');
  const missing = markers.filter((m) => !blob.includes(m));
  if (missing.length) {
    throw new Error(
      `The reference checkout at ${ANTD} is STALE — it has no ${missing.join(', ')}.\n` +
      `Scoring against it would report conformance while those are missing.\n` +
      `Pull that checkout, or set DP_ANTD to one that is current.`
    );
  }
  return ANTD;
}
