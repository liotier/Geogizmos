/**
 * Regression tests for the flood-fill Web Worker.
 *
 * flood-worker.js is a classic (non-module) Worker script, so it's loaded
 * here with node:vm into a sandbox that stubs `self.postMessage` /
 * `self.addEventListener`, letting tests drive it exactly the way the main
 * thread does (postMessage in, collect posted messages out) without needing
 * a real browser Worker.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createContext, Script } from 'node:vm';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workerSource = readFileSync(path.join(__dirname, '../js/workers/flood-worker.js'), 'utf8');

function loadWorker() {
    let messageHandler = null;
    const sandbox = {
        self: {
            postMessage: () => {},
            addEventListener: (type, handler) => { if (type === 'message') messageHandler = handler; }
        },
        console: { log: () => {}, warn: () => {}, error: () => {} }
    };
    const context = createContext(sandbox);
    new Script(workerSource, { filename: 'flood-worker.js' }).runInContext(context);

    return {
        sandbox,
        send(data) {
            const posted = [];
            sandbox.self.postMessage = (msg) => posted.push(msg);
            messageHandler({ data });
            return posted;
        }
    };
}

/**
 * A bounded valley: a flat channel with quadratically rising side walls, a
 * headwall closing off the north end, and the south end left open until the
 * grid boundary - so both the confined north pocket and the open south
 * channel are ultimately bounded by the grid, giving a fully deterministic
 * outcome via stagnation detection.
 */
function buildValleyScenario() {
    const width = 80, height = 140;
    const channelCenterX = 40, channelHalfWidth = 8, wallSteepness = 3;
    const headwallY = 20, headwallSteepness = 3;

    const data = new Float32Array(width * height);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const wallElev = wallSteepness * Math.pow(Math.max(0, Math.abs(x - channelCenterX) - channelHalfWidth), 2);
            const northWallElev = headwallSteepness * Math.pow(Math.max(0, headwallY - y), 2);
            data[y * width + x] = wallElev + northWallElev;
        }
    }

    const damY = 70;
    const damCells = [];
    for (let x = 25; x <= 55; x++) damCells.push(damY * width + x);

    const demData = {
        data, width, height,
        minX: 0, minY: 0,
        tileBounds: [0, 0, 0, 0],
        zoom: 14,
        geoBounds: [0, 0, 1, 1]
    };

    return { demData, damCells };
}

test('performIncrementalFlood floods the confined valley pocket deterministically', () => {
    const worker = loadWorker();
    const { demData, damCells } = buildValleyScenario();

    const posted = worker.send({
        demData,
        damCells,
        // edgeProximityThreshold: 0 disables edge-expansion (x<0 and x>=width
        // are never true), so the outcome is decided purely by stagnation
        // detection / natural array bounds.
        config: { edgeProximityThreshold: 0, maxReservoirAreaKm2: 1e9, layerCheckInterval: 20, progressUpdateInterval: 1000 }
    });

    const result = posted.find(m => m.flooded);
    assert.ok(result, 'worker should report a completed flood, not an error or DEM-expansion request');
    assert.equal(result.flooded.length, 1612);
    assert.equal(result.barriers.length, 31);
    assert.equal(result.damLevel, 147);
    assert.equal(result.maxWaterLevel, 146);
});

test('extendDamToMountainside returns {barriers, damLevel} even for degenerate dams', () => {
    const worker = loadWorker();
    const data = new Float32Array([5, 8, 12, 3]);

    // Sets created inside the vm sandbox are a different realm's Set, so
    // check shape rather than `instanceof` (which would always be false here).
    const isSetLike = (v) => v && typeof v.has === 'function' && typeof v.size === 'number';

    const singleCell = worker.sandbox.extendDamToMountainside([0], data, 2, 2);
    assert.ok(isSetLike(singleCell.barriers));
    assert.equal(singleCell.damLevel, 5);

    const zeroLength = worker.sandbox.extendDamToMountainside([0, 0], data, 2, 2);
    assert.ok(isSetLike(zeroLength.barriers));
    assert.equal(zeroLength.damLevel, 5);
});

test('worker reports an error and does not flood when dam sides merge', () => {
    const worker = loadWorker();
    // A dam with both endpoints at the same low elevation and no walls at all -
    // water can flow freely around both ends, so left/right sides must merge.
    const width = 40, height = 40;
    const data = new Float32Array(width * height); // all zeros - flat, open terrain
    const damCells = [20 * width + 15, 20 * width + 16, 20 * width + 17, 20 * width + 18, 20 * width + 19, 20 * width + 20, 20 * width + 21];
    // Raise the dam cells themselves a bit above 0 so there's a real crest
    for (const cell of damCells) data[cell] = 10;

    const demData = { data, width, height, minX: 0, minY: 0, tileBounds: [0, 0, 0, 0], zoom: 14, geoBounds: [0, 0, 1, 1] };

    const posted = worker.send({
        demData,
        damCells,
        config: { edgeProximityThreshold: 0, maxReservoirAreaKm2: 1e9, layerCheckInterval: 5, progressUpdateInterval: 1000 }
    });

    const error = posted.find(m => m.error);
    assert.ok(error, 'flat open terrain around a short dam should trigger the sides-merged error');
    assert.match(error.error, /merged|ineffective/i);
});
