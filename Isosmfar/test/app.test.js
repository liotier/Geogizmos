/**
 * Regression tests for pure logic in Isosmfar's app.js.
 *
 * app.js is a classic (non-module) script that runs browser-dependent code
 * at load time (checks navigator/window/document), so it's loaded here with
 * node:vm into a sandbox stubbing just enough of those globals to let the
 * script finish loading. A line is appended to the source that copies the
 * script's top-level `const`/`class` bindings (which don't attach to the vm
 * context's global object the way `function` declarations do) onto
 * `globalThis.__exports`, making them reachable from the test.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createContext, Script } from 'node:vm';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appSource = readFileSync(path.join(__dirname, '../app.js'), 'utf8');

// Plain objects/arrays returned from the vm sandbox belong to a different
// realm (different Object.prototype), which trips up assert.deepEqual's
// reference-equality-of-prototype check even when the data is identical.
// Compare structurally via JSON instead.
function assertStructurallyEqual(actual, expected, message) {
    assert.equal(JSON.stringify(actual), JSON.stringify(expected), message);
}

function loadApp() {
    const sandbox = {
        navigator: { userAgent: 'node-test', maxTouchPoints: 0 },
        window: { innerWidth: 1920 },
        document: {
            readyState: 'complete',
            addEventListener: () => {},
            getElementById: () => null,
            createElement: () => ({
                style: {}, classList: { add() {}, remove() {}, toggle() {} },
                addEventListener() {}, appendChild() {}, setAttribute() {}
            }),
            querySelectorAll: () => [],
            body: { insertBefore() {}, appendChild() {} }
        },
        location: { hash: '' },
        localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
        console: { log: () => {}, warn: () => {}, error: () => {} },
        URLSearchParams
    };
    sandbox.globalThis = sandbox;
    const context = createContext(sandbox);
    new Script(
        appSource + '\nglobalThis.__exports = { urlState, IsosmfarApp };',
        { filename: 'app.js' }
    ).runInContext(context);
    return { sandbox, ...sandbox.__exports };
}

// --- processOverpassFilter -------------------------------------------------

test('processOverpassFilter wraps a bare key=value in brackets', () => {
    const { IsosmfarApp } = loadApp();
    const result = IsosmfarApp.prototype.processOverpassFilter.call({}, 'amenity=hospital');
    assert.equal(result, '[amenity=hospital]');
});

test('processOverpassFilter handles "and"-joined and comma-joined conditions', () => {
    const { IsosmfarApp } = loadApp();
    assert.equal(
        IsosmfarApp.prototype.processOverpassFilter.call({}, 'amenity=hospital and shop=supermarket'),
        '[amenity=hospital][shop=supermarket]'
    );
    assert.equal(
        IsosmfarApp.prototype.processOverpassFilter.call({}, 'amenity=hospital, shop=supermarket'),
        '[amenity=hospital][shop=supermarket]'
    );
});

test('processOverpassFilter leaves an already-bracketed query untouched', () => {
    const { IsosmfarApp } = loadApp();
    assert.equal(
        IsosmfarApp.prototype.processOverpassFilter.call({}, '[amenity=hospital]'),
        '[amenity=hospital]'
    );
});

test('processOverpassFilter auto-quotes colon keys', () => {
    const { IsosmfarApp } = loadApp();
    assert.equal(
        IsosmfarApp.prototype.processOverpassFilter.call({}, 'recycling:glass=yes'),
        '["recycling:glass"=yes]'
    );
});

// --- extractCurrentTag -------------------------------------------------

test('extractCurrentTag identifies a key with no value yet', () => {
    const { IsosmfarApp } = loadApp();
    const result = IsosmfarApp.prototype.extractCurrentTag.call({}, 'amenity', 7);
    assert.equal(result.key, 'amenity');
    assert.equal(result.value, null);
    assert.equal(result.isValue, false);
});

test('extractCurrentTag identifies a key=value pair with cursor in the value', () => {
    const { IsosmfarApp } = loadApp();
    const result = IsosmfarApp.prototype.extractCurrentTag.call({}, 'amenity=hosp', 12);
    assert.equal(result.key, 'amenity');
    assert.equal(result.value, 'hosp');
    assert.equal(result.isValue, true);
});

// --- determineAreaSelector (P1.4) -------------------------------------------------

test('determineAreaSelector uses the relation area-id formula for relations', () => {
    const { IsosmfarApp } = loadApp();
    const result = IsosmfarApp.prototype.determineAreaSelector.call({}, { osm_type: 'relation', osm_id: '12345' });
    assertStructurallyEqual(result, { type: 'area', areaId: 3600012345 });
});

test('determineAreaSelector uses the way area-id formula for ways', () => {
    const { IsosmfarApp } = loadApp();
    const result = IsosmfarApp.prototype.determineAreaSelector.call({}, { osm_type: 'way', osm_id: '999' });
    assertStructurallyEqual(result, { type: 'area', areaId: 2400000999 });
});

test('determineAreaSelector falls back to a bbox query for nodes', () => {
    const { IsosmfarApp } = loadApp();
    const result = IsosmfarApp.prototype.determineAreaSelector.call({}, {
        osm_type: 'node', osm_id: '1', boundingbox: ['1.0', '2.0', '3.0', '4.0']
    });
    assertStructurallyEqual(result, { type: 'bbox', bbox: [1, 3, 2, 4] });
});

// --- parseCSV -------------------------------------------------

test('parseCSV parses Overpass CSV output and deduplicates identical points', () => {
    const { IsosmfarApp } = loadApp();
    const csv = '@id\t@lat\t@lon\n1\t10.5\t20.5\n2\t10.5\t20.5\n3\t11.5\t21.5\n';
    const result = IsosmfarApp.prototype.parseCSV.call({}, csv);
    assertStructurallyEqual(result, [{ lat: 10.5, lon: 20.5 }, { lat: 11.5, lon: 21.5 }]);
});

// --- formatCount -------------------------------------------------

test('formatCount abbreviates large numbers', () => {
    const { IsosmfarApp } = loadApp();
    assert.equal(IsosmfarApp.prototype.formatCount.call({}, 500), '500');
    assert.equal(IsosmfarApp.prototype.formatCount.call({}, 1500), '1.5K');
    assert.equal(IsosmfarApp.prototype.formatCount.call({}, 2500000), '2.5M');
});

// --- urlState (P1.7) -------------------------------------------------

test('urlState.decode only coerces known-numeric/boolean keys', () => {
    const { urlState, sandbox } = loadApp();
    sandbox.location.hash = '#transparency=0&voronoi=false&area=2000&mode=distance';
    const state = urlState.decode();
    assert.equal(state.transparency, 0);
    assert.equal(typeof state.transparency, 'number');
    assert.equal(state.voronoi, false);
    assert.equal(typeof state.voronoi, 'boolean');
    // "2000" looks numeric but `area` isn't a known-numeric key - must stay a string
    assert.equal(state.area, '2000');
    assert.equal(typeof state.area, 'string');
    assert.equal(state.mode, 'distance');
});

test('urlState.encode/decode round-trips falsy values (P1.7 regression)', () => {
    const { urlState, sandbox } = loadApp();
    const encoded = urlState.encode({ transparency: 0, voronoi: false, radius: 50 });
    sandbox.location.hash = '#' + encoded;
    const decoded = urlState.decode();
    assert.equal(decoded.transparency, 0);
    assert.equal(decoded.voronoi, false);
    assert.equal(decoded.radius, 50);
});
