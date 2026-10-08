// Reference render: the REAL OverlayCanvasRenderer / ElementRenderer components
// from digitalpool-antd, mounted in a browser exactly as the public OBS endpoint
// mounts them. Nothing here reimplements the renderer — that is the whole point.
// The local Skia renderer is scored against whatever this draws.
import React from 'react';
import { createRoot } from 'react-dom/client';
import OverlayCanvasRenderer from 'ANTD/src/screens/overlay-builder/renderers/OverlayCanvasRenderer';
import { EXAMPLES } from 'ANTD/src/screens/overlay-builder/data/examples';
import { makeElement, DEFAULT_CANVAS } from 'ANTD/src/screens/overlay-builder/data/elementTypes';
import { SAMPLE_BINDING } from 'ANTD/src/screens/overlay-builder/data/sampleBinding';

// Examples store partial element configs; the builder inflates them through
// makeElement, so do the same to get the canvas a saved overlay would hold.
export function canvasForExample(key) {
    const ex = EXAMPLES[key];
    if (!ex) throw new Error(`unknown example: ${key}`);
    return { ...DEFAULT_CANVAS, elements: (ex.elements || []).map((e) => makeElement(e.type, e)) };
}

window.__EXAMPLE_KEYS__ = Object.keys(EXAMPLES);
window.__canvasForExample__ = canvasForExample;

window.__SAMPLE_BINDING__ = SAMPLE_BINDING;

// Mount any canvas/binding the harness hands us. Used for overlays pulled
// straight out of the database and for synthetic fixtures, not just the
// built-in examples.
let _root = null;
window.__render__ = function (canvas, binding) {
    window.__CANVAS__ = canvas;
    window.__BINDING__ = binding;
    if (!_root) _root = createRoot(document.getElementById('root'));
    _root.render(<OverlayCanvasRenderer canvas={canvas} binding={binding} scale={1} />);
};

const params = new URLSearchParams(window.location.search);
const key = params.get('example');
if (key) {
    // Expose the inflated canvas so the harness drives the Skia renderer from
    // byte-identical input rather than from its own copy of the examples.
    window.__render__(canvasForExample(key), SAMPLE_BINDING);
}
