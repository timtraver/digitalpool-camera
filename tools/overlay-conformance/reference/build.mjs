// Bundles reference/entry.jsx against the digitalpool-antd working tree.
// Resolution runs with absWorkingDir set to that repo so its node_modules
// (react, react-circle-flags, …) and relative asset imports resolve as they do
// in the real app; image/font imports become data URLs so flags and ball icons
// render for real instead of as placeholders.
import esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export { ANTD } from '../antd.mjs';
import { ANTD } from '../antd.mjs';

const antdAlias = {
  name: 'antd-alias',
  setup(build) {
    // Force React to resolve to the ONE copy in digitalpool-antd. entry.jsx
    // lives in this directory, so esbuild would otherwise resolve its `react`
    // here and the components' `react` over there — two copies, and any
    // component using hooks dies with "Cannot read properties of null (reading
    // 'useState')". Only MatchClock and ImageCarousel use hooks, so this stays
    // invisible until a fixture includes match_clock or image_carousel.
    build.onResolve({ filter: /^react(-dom)?(\/.*)?$/ }, (args) => {
      const sub = args.path.replace(/^react(-dom)?/, '');
      const base = path.join(ANTD, 'node_modules', args.path.startsWith('react-dom') ? 'react-dom' : 'react');
      const target = sub ? path.join(base, sub) : base;
      for (const cand of [target, `${target}.js`, path.join(target, 'index.js')]) {
        if (fs.existsSync(cand) && fs.statSync(cand).isFile()) return { path: cand };
      }
      return undefined; // let esbuild resolve it normally
    });
    // Stub the app infrastructure the renderer now reaches into.
    //
    // ElementRenderer gained `components/advertising/AdCarousel` in November,
    // which pulls in Apollo and Firebase at module load. Those cannot
    // initialise outside the real app, so the page threw before React drew
    // anything and every capture came back blank — scored, silently, as a 97%
    // difference blamed on every element type.
    //
    // Stubbing rather than configuring is the right call here: this harness
    // compares DRAWING, and an ad carousel with no ad service has nothing to
    // draw. The legacy `ad_center` type is required to draw nothing on air
    // anyway (OVERLAY_ELEMENTS_2025_11 §7), so a stub that renders null is
    // also the behaviour the device must match.
    const STUBBED = [
      /\/components\/advertising\/AdCarousel(\.jsx?)?$/,
      /\/(apollo|firebase)(Client|Config)?(\.jsx?)?$/,
    ];
    build.onResolve({ filter: /.*/ }, (args) => {
      if (!args.importer) return undefined;
      const resolved = args.path.startsWith('.')
        ? path.resolve(path.dirname(args.importer), args.path)
        : args.path;
      if (STUBBED.some((re) => re.test(resolved))) {
        return { path: resolved, namespace: 'reference-stub' };
      }
      return undefined;
    });
    // CommonJS with a Proxy, so ANY named import is satisfied — these modules
    // are imported for `auth`, `db`, `client` and more, and a stub that only
    // has a default export fails the build instead of the render.
    build.onLoad({ filter: /.*/, namespace: 'reference-stub' }, () => ({
      contents: [
        'function Stub() { return null; }',
        'module.exports = new Proxy(Stub, {',
        '  get: (target, key) => {',
        "    if (key === '__esModule') return true;",
        "    if (key === 'default') return Stub;",
        '    if (key in target) return target[key];',
        '    return Stub;',
        '  },',
        '});',
      ].join('\n'),
      loader: 'js',
    }));

    // A path returned from onResolve is final — esbuild does no extension
    // probing on it — so do the .js/.jsx/index lookup here.
    build.onResolve({ filter: /^ANTD\// }, (args) => {
      const base = path.join(ANTD, args.path.slice('ANTD/'.length));
      for (const cand of [base, `${base}.js`, `${base}.jsx`, path.join(base, 'index.js')]) {
        if (fs.existsSync(cand) && fs.statSync(cand).isFile()) return { path: cand };
      }
      return { errors: [{ text: `ANTD alias: nothing at ${base}` }] };
    });
  },
};

export async function buildReference() {
  const outfile = path.join(HERE, 'out', 'reference.bundle.js');
  fs.mkdirSync(path.dirname(outfile), { recursive: true });
  await esbuild.build({
    entryPoints: [path.join(HERE, 'entry.jsx')],
    bundle: true,
    outfile,
    format: 'iife',
    platform: 'browser',
    absWorkingDir: ANTD,
    nodePaths: [path.join(ANTD, 'node_modules')],
    plugins: [antdAlias],
    loader: {
      '.js': 'jsx',
      '.png': 'dataurl',
      '.jpg': 'dataurl',
      '.jpeg': 'dataurl',
      '.gif': 'dataurl',
      '.svg': 'dataurl',
      '.woff': 'dataurl',
      '.woff2': 'dataurl',
      '.ttf': 'dataurl',
      '.eot': 'dataurl',
      '.css': 'empty',
      '.less': 'empty',
    },
    define: { 'process.env.NODE_ENV': '"production"', global: 'window' },
    // Parts of the app's dependency tree touch `process` outside of
    // process.env.NODE_ENV (apollo, graphql). A browser bundle has none, so
    // stub it rather than aliasing half a dozen modules away.
    banner: {
      js: "window.process = window.process || { env: { NODE_ENV: 'production' }, browser: true, version: '', nextTick: function (f) { setTimeout(f, 0); } };",
    },
    logLevel: 'silent',
  });
  return outfile;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const f = await buildReference();
  console.log('built', f, (fs.statSync(f).size / 1024).toFixed(0) + ' KB');
}
