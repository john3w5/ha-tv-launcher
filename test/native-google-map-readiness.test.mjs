import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Execute the actual Java-owned JS without a browser, JDK build or network.
const java = readFileSync(new URL('../android/app/src/main/java/org/hometv/launcher/NativeGoogleMapPolicy.java', import.meta.url), 'utf8');
const method = java.match(/public static String readinessScript\(\) \{([\s\S]*?)\n    \}/)?.[1];
assert.ok(method, 'production readiness script is present');
const script = [...method.matchAll(/"(?:[^"\\]|\\.)*"/g)].map(([literal]) => JSON.parse(literal)).join('');
const wrapperMethod = java.match(/public static String wrapperReadinessScript\(\) \{([\s\S]*?)\n    \}/)?.[1];
assert.ok(wrapperMethod, 'production wrapper readiness script is present');
const wrapperScript = [...wrapperMethod.matchAll(/"(?:[^"\\]|\\.)*"/g)].map(([literal]) => JSON.parse(literal)).join('');

const rect = (left, top, width, height) => ({ left, top, right: left + width, bottom: top + height, width, height });
const normal = { display: 'block', visibility: 'visible', opacity: '1', overflowX: 'visible', overflowY: 'visible' };
function element(box, style = {}, parentElement = null) {
  return { parentElement, style: { ...normal, ...style }, getBoundingClientRect: () => box };
}
function canvas(box, style = {}, parentElement = null, width = 800, height = 400) {
  return { ...element(box, style, parentElement), tagName: 'CANVAS', width, height };
}
function probe({ canvases = [], map = null, readyState = 'complete', width = 1000, height = 400, error = false } = {}) {
  const document = {
    readyState, body: { childElementCount: 11 }, documentElement: { clientWidth: width, clientHeight: height },
    images: [], scripts: { length: 14 },
    querySelector: selector => selector === '.gm-style' ? map : selector === '.gm-err-container' && error ? {} : null,
    getElementsByTagName: tag => tag === 'canvas' ? canvases : [],
  };
  return Array.from(vm.runInNewContext(script, {
    document, performance: { getEntriesByType: () => ({ length: 112 }) },
    window: { innerWidth: width, innerHeight: height, getComputedStyle: node => node.style },
  }));
}

test('consumer map uses the largest visible global canvas and bounded parent metrics', () => {
  const parent = element(rect(-50, -20, 1500, 900));
  const r = probe({ canvases: [canvas(rect(0, 0, 220, 100)), canvas(rect(20, 20, 800, 300), {}, parent)] });
  assert.equal(r[0], 47); // Known readiness bits plus explicit global-canvas fallback=32.
  assert.deepEqual(r.slice(1, 4), [1000, 400, 3]);
  assert.equal(r[7], 2);
});

test('fallback accepts interactive DOM but waits while the document is loading', () => {
  const canvases = [canvas(rect(0, 0, 800, 300))];
  assert.equal(probe({ canvases, readyState: 'interactive' })[0], 47);
  assert.equal(probe({ canvases, readyState: 'loading' })[0], 0);
});

test('small analytics and offscreen canvases do not unmask the map', () => {
  for (const box of [rect(0, 0, 199, 200), rect(0, 0, 500, 99), rect(1001, 0, 500, 200), rect(-500, 0, 600, 200), rect(0, 401, 500, 200)]) {
    assert.equal(probe({ canvases: [canvas(box)] })[0], 0);
  }
});

test('CSS-hidden, transparent and zero-buffer canvases do not unmask the map', () => {
  for (const style of [{ display: 'none' }, { visibility: 'hidden' }, { visibility: 'collapse' }, { opacity: '0' }]) {
    assert.equal(probe({ canvases: [canvas(rect(0, 0, 800, 300), style)] })[0], 0);
  }
  assert.equal(probe({ canvases: [canvas(rect(0, 0, 800, 300), {}, null, 0, 400)] })[0], 0);
});

test('hidden ancestors and clipped parent rectangles cannot qualify a canvas', () => {
  const hidden = element(rect(0, 0, 800, 300), { opacity: '0' });
  const clipped = element(rect(0, 0, 100, 80), { overflowX: 'hidden', overflowY: 'hidden' });
  assert.equal(probe({ canvases: [canvas(rect(0, 0, 800, 300), {}, hidden)] })[0], 0);
  assert.equal(probe({ canvases: [canvas(rect(0, 0, 800, 300), {}, clipped)] })[0], 0);
});

test('known containers retain their path and map errors remain visible', () => {
  const map = { getBoundingClientRect: () => rect(0, 0, 800, 300), querySelectorAll: () => [canvas(rect(0, 0, 800, 300))] };
  assert.equal(probe({ map })[0], 15);
  assert.equal(probe({ canvases: [canvas(rect(0, 0, 800, 300))], error: true })[0], 63);
});

test('fallback scans at most 64 canvases and emits only the fixed numeric result', () => {
  let reads = 0;
  const canvases = new Proxy({ length: 1000000 }, { get: (target, key) => {
    if (key === 'length') return target.length;
    reads++;
    assert.ok(Number(key) < 64);
    return canvas(rect(0, 0, 1, 1));
  } });
  const r = probe({ canvases });
  assert.equal(reads, 64);
  assert.equal(r.length, 12);
  assert.ok(r.every(Number.isFinite));
  assert.ok(r.every(Number.isInteger));
  assert.equal(r[7], 4095);
});

test('owned wrapper reports iframe load separately from inner-map rendering', () => {
  function run(loaded, width = 800, height = 300) {
    return Array.from(vm.runInNewContext(wrapperScript, { document: {
      readyState: 'complete', body: { childElementCount: 1 },
      getElementById: id => id === 'home-tv-map-frame' ? { getBoundingClientRect: () => rect(0, 0, width, height) } : null,
      documentElement: { getAttribute: () => loaded ? '1' : null },
    } }));
  }
  assert.equal(run(false)[0], 0);
  assert.equal(run(true)[0], 64);
  assert.equal(run(true)[0] & 15, 0);
  assert.equal(run(true, 800, 199)[0], 0);
  assert.equal(run(true, 199, 300)[0], 0);
  for (const forbidden of ['contentDocument', 'contentWindow', 'document.cookie', 'fetch(', 'postMessage']) assert.ok(!wrapperScript.includes(forbidden));
});
