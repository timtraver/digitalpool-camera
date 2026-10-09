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
export const ANTD = '/Users/timtraver/Projects/digitalpool-antd';

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
