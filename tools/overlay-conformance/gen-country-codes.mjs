// Regenerates ../../overlayCountryCodes.js from the web app's own lookup tables,
// so the device resolves a player's country to a flag exactly as CircleFlag does.
// Run this whenever digitalpool-antd/src/utils/isoCountryCodes.js changes.
import fs from 'node:fs';

const SRC = '/Users/timtraver/Projects/digitalpool-antd/src/utils/isoCountryCodes.js';
const DEST = new URL('../../overlayCountryCodes.js', import.meta.url).pathname;

const src = fs.readFileSync(SRC, 'utf8').replace(/export const /g, 'const ');
const maps = new Function(`${src}; return { isoCountries, isoCountries3 };`)();

fs.writeFileSync(
  DEST,
  '// Country name / ISO-3 → ISO-2 lookup, generated from\n' +
    '// digitalpool-antd/src/utils/isoCountryCodes.js. Regenerate when that file changes:\n' +
    '//   node tools/overlay-conformance/gen-country-codes.mjs\n' +
    '// Used by overlayRenderer.js to resolve player_flag the way CircleFlag does.\n' +
    `module.exports = ${JSON.stringify(maps, null, 2)};\n`
);
console.log(
  `wrote ${DEST}: ${Object.keys(maps.isoCountries).length} names, ${Object.keys(maps.isoCountries3).length} iso3 codes`
);
