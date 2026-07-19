import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as turf from '@turf/turf';
import { DamGeometry } from '../js/core/dam-geometry.js';

globalThis.turf = turf;

test('expandBounds only moves the requested edges', () => {
    const bounds = [10, 20, 11, 21]; // [west, south, east, north]
    const expanded = DamGeometry.expandBounds(bounds, { west: true, south: false, east: true, north: false }, 111);
    // 111km / 111 = 1 degree
    assert.equal(expanded[0], 9); // west moved
    assert.equal(expanded[1], 20); // south unchanged
    assert.equal(expanded[2], 12); // east moved
    assert.equal(expanded[3], 21); // north unchanged
});

test('expandBounds with no edges selected leaves bounds unchanged', () => {
    const bounds = [10, 20, 11, 21];
    const expanded = DamGeometry.expandBounds(bounds, { west: false, south: false, east: false, north: false }, 50);
    assert.deepEqual(expanded, bounds);
});

test('calculateDEMBounds centers a square buffer on the dam line', () => {
    const damLine = {
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: [[6.26, 44.98], [6.27, 44.99]] }
    };
    const bounds = DamGeometry.calculateDEMBounds(damLine, 10);
    const [west, south, east, north] = bounds;
    assert.ok(west < east);
    assert.ok(south < north);
    // Buffer should be roughly symmetric around the line's center
    const centerLng = (west + east) / 2;
    const centerLat = (south + north) / 2;
    assert.ok(Math.abs(centerLng - 6.265) < 0.01);
    assert.ok(Math.abs(centerLat - 44.985) < 0.01);
});

test('sampleLinePoints produces more samples for a longer line', () => {
    const shortLine = [[0, 0], [0, 0.001]]; // ~111m
    const longLine = [[0, 0], [0, 0.01]]; // ~1111m
    const shortSamples = DamGeometry.sampleLinePoints(shortLine, 10);
    const longSamples = DamGeometry.sampleLinePoints(longLine, 10);
    assert.ok(longSamples.length > shortSamples.length);
});
