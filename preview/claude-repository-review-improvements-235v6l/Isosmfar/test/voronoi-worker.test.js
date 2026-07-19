/**
 * Regression tests for voronoi-worker.js's coalescePoints() - the only
 * function in that file with no dependency on turf/d3-delaunay, so
 * `importScripts` can be stubbed out entirely for testing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createContext, Script } from 'node:vm';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workerSource = readFileSync(path.join(__dirname, '../voronoi-worker.js'), 'utf8');

function loadWorker() {
    const sandbox = {
        importScripts: () => {}, // no-op: coalescePoints doesn't need turf/d3-delaunay
        self: { onmessage: null, postMessage: () => {} },
        console
    };
    const context = createContext(sandbox);
    new Script(workerSource, { filename: 'voronoi-worker.js' }).runInContext(context);
    return sandbox;
}

test('coalescePoints returns features unchanged when distance is 0', () => {
    const { coalescePoints } = loadWorker();
    const features = [{ lat: 10, lon: 20 }, { lat: 10.1, lon: 20.1 }];
    const result = coalescePoints(features, 0);
    assert.equal(result, features);
});

test('coalescePoints merges nearby points into their centroid', () => {
    const { coalescePoints } = loadWorker();
    // Two points ~100m apart at the equator (where 1 deg lon ~= 1 deg lat in km)
    const features = [{ lat: 0, lon: 0 }, { lat: 0, lon: 0.001 }];
    const result = coalescePoints(features, 1); // 1km coalesce radius
    assert.equal(result.length, 1);
    assert.ok(Math.abs(result[0].lat - 0) < 1e-6);
    assert.ok(Math.abs(result[0].lon - 0.0005) < 1e-6);
});

test('coalescePoints leaves distant points separate', () => {
    const { coalescePoints } = loadWorker();
    const features = [{ lat: 0, lon: 0 }, { lat: 5, lon: 5 }]; // hundreds of km apart
    const result = coalescePoints(features, 1);
    assert.equal(result.length, 2);
});

test('coalescePoints corrects for latitude (P1.5 regression)', () => {
    const { coalescePoints } = loadWorker();
    // Two points 0.01 deg of longitude apart. At the equator that's ~1.1km
    // (stays separate at a 0.5km radius); at 80N the same longitude delta is
    // only ~0.19km of ground distance (must coalesce at the same radius).
    // A naive degree-based distance check (pre-P1.5) would treat both
    // latitudes identically and merge neither or both.
    const equatorPoints = [{ lat: 0, lon: 0 }, { lat: 0, lon: 0.01 }];
    const highLatPoints = [{ lat: 80, lon: 0 }, { lat: 80, lon: 0.01 }];

    const equatorResult = coalescePoints(equatorPoints, 0.5);
    const highLatResult = coalescePoints(highLatPoints, 0.5);

    assert.equal(equatorResult.length, 2, 'equator points ~1.1km apart should stay separate at 0.5km radius');
    assert.equal(highLatResult.length, 1, 'high-latitude points ~0.19km apart (ground distance) should coalesce at 0.5km radius');
});
