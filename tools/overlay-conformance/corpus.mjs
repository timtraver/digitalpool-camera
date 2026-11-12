// Test corpora for the conformance run.
//
//   examples — the 14 built-in layouts in the builder (see reference/shot.mjs)
//   database — every overlay the device can actually read from DigitalPool,
//              i.e. what venues really use
//   kitchen  — a synthetic layout containing EVERY element type, so no type is
//              scored only by hoping some example happened to use it
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const dataSource = require('../../overlayDataSource.js');

import { ANTD } from './antd.mjs';

// elementTypes.js is dependency-free ESM, so the builder's own makeElement() and
// DEFAULT_STYLE can be used directly rather than reimplemented here.
function builderDefs() {
  const src = fs.readFileSync(`${ANTD}/src/screens/overlay-builder/data/elementTypes.js`, 'utf8')
    .replace(/export const /g, 'const ')
    .replace(/export function /g, 'function ');
  return new Function(`${src}; return { makeElement, DEFAULT_STYLE, ELEMENT_TYPES, DEFAULT_CANVAS };`)();
}

// SAMPLE_BINDING leaves avatar/logo null and has no table label, so image-bearing
// element types draw as empty placeholders and never get compared. Fill those in
// with real URLs so they are actually exercised.
export const RICH_BINDING_EXTRAS = {
  tournament: {
    logo: 'https://d2cqpja9v01i02.cloudfront.net/media/images/1791479050422-ariakon-logo_c8502f57.png',
    game_type: '9-Ball',
  },
  table: { label: 'Table 7' },
  match: {
    challenger1_avatarImg: 'https://d2cqpja9v01i02.cloudfront.net/media/images/1791479080485-Circle_Logo_Text_Centered_White_6d1da86b.png',
    challenger2_avatarImg: 'https://d2cqpja9v01i02.cloudfront.net/media/images/1791479080485-Circle_Logo_Text_Centered_White_6d1da86b.png',
    challenger1_race_to: 9,
    challenger2_race_to: 7,
  },
};

// A real sponsor carousel's artwork, so image_carousel is exercised with the
// kind of images it actually carries.
export const CAROUSEL_IMAGES = [
  "https://d2cqpja9v01i02.cloudfront.net/media/images/1791482272431-Good_Times_Billiards_-_Sponsor_Carou_fc57630e.png",
  "https://d2cqpja9v01i02.cloudfront.net/media/images/1791482276914-Good_Times_Billiards_-_Sponsor_Carou_2bad64a7.png",
  "https://d2cqpja9v01i02.cloudfront.net/media/images/1791482282097-Good_Times_Billiards_-_Sponsor_Carou_77efb6ed.png"
];

export function richBinding(sample) {
  return {
    tournament: { ...sample.tournament, ...RICH_BINDING_EXTRAS.tournament },
    table: { ...sample.table, ...RICH_BINDING_EXTRAS.table },
    match: { ...sample.match, ...RICH_BINDING_EXTRAS.match },
  };
}

/**
 * Strip ES import statements and stub what they bound.
 *
 * These reference data files are evaluated with `new Function`, which cannot
 * parse `import`. sampleBinding.js gained one in November (resolveRaceSettings,
 * for the stage race-to) and the harness stopped loading entirely — it could
 * not even read the reference it is supposed to score against. Stubbing rather
 * than resolving is deliberate: what is wanted here is the literal
 * SAMPLE_BINDING object, and the helpers that use those imports are not called.
 * A stub that IS called throws by name, which is a readable failure.
 */
function stripImports(src) {
  const names = [];
  const stripped = src.replace(
    /^import\s+(?:([\w$]+)\s*,?\s*)?(?:\{([^}]*)\})?\s*from\s*['"][^'"]+['"];?\s*$/gm,
    (_line, dflt, braced) => {
      if (dflt) names.push(dflt.trim());
      if (braced) {
        for (const part of braced.split(',')) {
          const name = part.split(/\s+as\s+/).pop().trim();
          if (name) names.push(name);
        }
      }
      return '';
    }
  );
  const stubs = names
    .map((n) => `const ${n} = (...a) => { throw new Error('stubbed import ${n}() was called'); };`)
    .join('\n');
  return `${stubs}\n${stripped}`;
}

/** The builder's own sample binding, used so runs are deterministic. */
export function sampleBinding() {
  const src = stripImports(
    fs.readFileSync(`${ANTD}/src/screens/overlay-builder/data/sampleBinding.js`, 'utf8')
  )
    .replace(/export const /g, 'const ')
    .replace(/export function /g, 'function ');
  return new Function(`${src}; return SAMPLE_BINDING;`)();
}

/** Every overlay the anonymous role can read — what venues actually run. */
export async function databaseOverlays(limit = 40) {
  const data = await dataSource._internals.graphql(
    `query { user_overlays(order_by: {id: asc}, limit: ${limit}) { id name canvas } }`, {}
  );
  return (data.user_overlays || [])
    .filter((o) => o.canvas && Array.isArray(o.canvas.elements) && o.canvas.elements.length)
    .map((o) => ({
      key: `db${o.id}_${String(o.name || 'overlay').toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 28)}`,
      canvas: o.canvas,
    }));
}

/**
 * One canvas holding every element type the builder can produce, including the
 * ones no example uses. Styling deliberately varies across the grid so padding,
 * borders, radii, shadows, rotation, alignment and transforms are all compared
 * rather than just the happy path.
 */
/**
 * Every element type the builder can produce, read from the builder. Never a
 * literal: the one this replaced listed 20 types while the builder had grown
 * to 26, so the run reported "NOT IMPLEMENTED: (none)" while five November
 * types were neither drawn nor missed.
 */
export function builderTypes() {
  return Object.keys(builderDefs().ELEMENT_TYPES);
}

export function kitchenSink() {
  const { makeElement, DEFAULT_STYLE, ELEMENT_TYPES } = builderDefs();
  // Derived from the reference, never hardcoded. This list was a literal of 20
  // types and the builder had grown to 26, so the fixture silently stopped
  // exercising everything added after it was written — and the harness
  // cheerfully reported "20/20 element types" and a 0.2% diff while five
  // November types were not drawn at all. A gate that cannot see the work is
  // worse than no gate, because it says "pass".
  const TYPES = Object.keys(ELEMENT_TYPES);
  // Vary the styling deterministically so the fixture is stable run to run.
  const FONTS = ['inherit', 'Anton', 'Teko', 'Oswald', 'Roboto Condensed', 'UniformCondensed'];
  const ALIGN = ['left', 'center', 'right'];
  const TRANSFORM = ['none', 'uppercase', 'capitalize'];

  const elements = [];
  const COLS = 5, CELL_W = 360, CELL_H = 200, PAD = 24;
  TYPES.forEach((type, i) => {
    const col = i % COLS, row = Math.floor(i / COLS);
    const el = makeElement(type, {
      x: PAD + col * CELL_W,
      y: PAD + row * CELL_H,
      w: CELL_W - PAD * 2,
      h: CELL_H - PAD * 2,
      zIndex: i + 2,
      rotation: i % 7 === 6 ? -4 : 0,
      opacity: i % 5 === 4 ? 0.75 : 1,
      player: i % 2 === 0 ? 1 : 2,
      style: {
        ...DEFAULT_STYLE,
        fontFamily: FONTS[i % FONTS.length],
        fontSize: 20 + (i % 4) * 8,
        fontWeight: [400, 600, 700][i % 3],
        color: ['#ffffff', '#ffd700', '#1890ff'][i % 3],
        backgroundColor: i % 3 === 0 ? 'rgba(0,0,0,0.45)' : 'transparent',
        padding: [0, 8, 16][i % 3],
        borderRadius: [0, 12, '0 24px 0 24px', '50%'][i % 4],
        border: i % 4 === 1 ? '2px solid rgba(255,215,0,0.5)' : 'none',
        textAlign: ALIGN[i % 3],
        textTransform: TRANSFORM[i % 3],
        letterSpacing: i % 5 === 3 ? 2 : 0,
        lineHeight: 1.2,
        textShadow: i % 3 === 2 ? '0 2px 4px rgba(0,0,0,0.6)' : 'none',
        boxShadow: i % 6 === 5 ? '0 4px 16px rgba(0,0,0,0.5)' : undefined,
      },
    });
    if (type === 'static_text') el.text = 'Static Text Sample';
    if (type === 'static_image') el.imageUrl = RICH_BINDING_EXTRAS.tournament.logo;
    if (type === 'shape') {
      el.shapeType = i % 2 ? 'circle' : 'rect';
      el.fill = { type: 'gradient', angle: 135, opacity: 0.9, stops: [
        { color: '#0f2027', position: 0 }, { color: '#2c5364', position: 100 },
      ] };
      el.stroke = { width: 2, color: '#ffd700', opacity: 0.6 };
    }
    if (type === 'break_indicator') {
      // A break indicator only draws on the side of the player whose break it
      // is, so left to the grid's alternating `player` it was a coin toss
      // whether this fixture exercised the drawn case at all — and it did not:
      // the element scored a perfect 0 by being blank on both sides. Pin it to
      // the player SAMPLE_BINDING has at the table.
      el.breakMode = 'shooting';
      el.player = 1;
    }
    if (type === 'image_carousel') {
      el.images = CAROUSEL_IMAGES;
      el.interval = 8;
      el.effect = 'fade';
    }
    elements.push(el);
  });

  // A backdrop so text contrast matches a real overlay rather than sitting on
  // transparency.
  elements.unshift(
    makeElement('shape', {
      x: 0, y: 0, w: 1920, h: PAD * 2 + Math.ceil(TYPES.length / COLS) * CELL_H,
      zIndex: 1, shapeType: 'rect',
      fill: { type: 'solid', color: '#16222b', opacity: 0.9 },
      stroke: { width: 0, color: '#000', opacity: 1 },
    })
  );

  return { key: 'kitchen_sink', canvas: { width: 1920, height: 1080, background: { type: 'transparent' }, elements } };
}
