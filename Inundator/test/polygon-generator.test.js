import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PolygonGenerator } from '../js/core/polygon-generator.js';

test('transformRingToGeo converts pixel coordinates to a closed geographic ring', () => {
    const zoom = 10;
    const tileBounds = [100, 200, 105, 205]; // [tileWest, tileNorth, tileEast, tileSouth]
    const width = 256 * 6, height = 256 * 6;

    // A simple pixel-space square, not pre-closed
    const ring = [[0, 0], [100, 0], [100, 100], [0, 100]];

    const geoRing = PolygonGenerator.transformRingToGeo(ring, zoom, tileBounds, width, height, 0, 0);

    assert.ok(geoRing, 'should produce a ring');
    // Ring must be closed (first point repeated at the end)
    assert.deepEqual(geoRing[0], geoRing[geoRing.length - 1]);
    // All coordinates must be finite, valid lng/lat pairs
    for (const [lng, lat] of geoRing) {
        assert.ok(Number.isFinite(lng) && lng >= -180 && lng <= 180);
        assert.ok(Number.isFinite(lat) && lat >= -90 && lat <= 90);
    }
});

test('transformRingToGeo returns null for a degenerate (too-short) ring', () => {
    const result = PolygonGenerator.transformRingToGeo([[0, 0], [1, 1]], 10, [0, 0, 1, 1], 256, 256, 0, 0);
    assert.equal(result, null);
});

test('transformRingToGeo drops out-of-bounds pixel coordinates', () => {
    const width = 256, height = 256;
    // One point is outside [0,width]x[0,height] and must be skipped
    const ring = [[0, 0], [100, 0], [100000, 100], [0, 100]];
    const geoRing = PolygonGenerator.transformRingToGeo(ring, 10, [0, 0, 1, 1], width, height, 0, 0);
    // 4 input points minus 1 out-of-bounds, plus the closing point = 4
    assert.equal(geoRing.length, 4);
});
