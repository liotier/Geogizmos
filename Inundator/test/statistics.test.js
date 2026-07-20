import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as turf from '@turf/turf';
import { Statistics } from '../js/core/statistics.js';

globalThis.turf = turf;

test('calculate derives depth/volume from the worker-reported water level', () => {
    // A flat 10x10 DEM grid at elevation 0, with a 3x3 flooded region
    const width = 10, height = 10;
    const data = new Float32Array(width * height).fill(0);
    const floodedCells = [];
    for (let y = 3; y < 6; y++) {
        for (let x = 3; x < 6; x++) floodedCells.push(y * width + x);
    }
    const demData = { data, width, height, zoom: 14, tileBounds: [0, 0, 0, 0], minX: 0, minY: 0 };

    const polygon = turf.polygon([[[0, 0], [0, 0.01], [0.01, 0.01], [0.01, 0], [0, 0]]]);
    const damLine = { type: 'Feature', geometry: { type: 'LineString', coordinates: [[0, 0], [0.01, 0]] } };

    const maxWaterLevel = 10; // the value the flood worker actually used
    const stats = Statistics.calculate(polygon, floodedCells, demData, damLine, maxWaterLevel, 5);

    assert.equal(stats.floodedCellCount, 9);
    assert.equal(stats.maxDepthM, 10); // crest(10) - min terrain elevation(0)
    assert.equal(stats.avgDepthM, 10); // flat terrain, so avg == max
    assert.ok(stats.areaM2 > 0);
    assert.equal(stats.elapsedSeconds, 5);
});

test('format renders human-readable units', () => {
    const formatted = Statistics.format({
        areaKm2: 1.5,
        volumeMillionM3: 2.25,
        maxDepthM: 12.34,
        avgDepthM: 6.78,
        damLengthM: 150.4,
        elapsedSeconds: 125
    });
    assert.equal(formatted.area, '1.50 km²');
    assert.equal(formatted.volume, '2.25 million m³');
    assert.equal(formatted.maxDepth, '12.3 m');
    assert.equal(formatted.avgDepth, '6.8 m');
    assert.equal(formatted.damLength, '150 m');
    assert.equal(formatted.elapsedTime, '2 minutes 5 seconds');
});
