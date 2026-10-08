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

const ANTD = '/Users/timtraver/Projects/digitalpool-antd';

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
    logo: 'https://digitalpool.s3.amazonaws.com/tournament-logos/HT-Logo_blue_200.png',
    game_type: '9-Ball',
  },
  table: { label: 'Table 7' },
  match: {
    challenger1_avatarImg: 'https://digitalpool.s3.us-west-1.amazonaws.com/users/12916/avatar_f72b5477.jpg',
    challenger2_avatarImg: 'https://digitalpool.s3.us-west-1.amazonaws.com/users/12916/avatar_f72b5477.jpg',
    challenger1_race_to: 9,
    challenger2_race_to: 7,
  },
};

export function richBinding(sample) {
  return {
    tournament: { ...sample.tournament, ...RICH_BINDING_EXTRAS.tournament },
    table: { ...sample.table, ...RICH_BINDING_EXTRAS.table },
    match: { ...sample.match, ...RICH_BINDING_EXTRAS.match },
  };
}

/** The builder's own sample binding, used so runs are deterministic. */
export function sampleBinding() {
  const src = fs.readFileSync(`${ANTD}/src/screens/overlay-builder/data/sampleBinding.js`, 'utf8')
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
export function kitchenSink() {
  const { makeElement, DEFAULT_STYLE } = builderDefs();
  const TYPES = [
    'player_name', 'player_flag', 'player_score', 'player_points', 'player_avatar',
    'player_skill_level', 'player_race_to', 'race_to', 'match_status', 'match_clock',
    'table_label', 'tournament_name', 'tournament_location', 'tournament_game_type',
    'tournament_game_type_image', 'tournament_logo', 'static_text', 'static_image',
    'shape', 'image_carousel',
  ];
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
    if (type === 'image_carousel') {
      el.images = [RICH_BINDING_EXTRAS.tournament.logo];
      el.interval = 5;
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
