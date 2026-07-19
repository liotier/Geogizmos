import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ElevationService } from '../js/core/elevation-service.js';

test('decodeTerrarium decodes the documented RGB->elevation formula', () => {
    // elevation = (R * 256 + G + B / 256) - 32768
    assert.equal(ElevationService.decodeTerrarium(128, 0, 0), 128 * 256 - 32768);
    assert.equal(ElevationService.decodeTerrarium(0, 0, 0), -32768);
    assert.equal(ElevationService.decodeTerrarium(128, 128, 128), 128 * 256 + 128 + 128 / 256 - 32768);
});

test('lngToTileX/latToTileY round-trip to roughly the original coordinate', () => {
    const zoom = 10;
    const lng = 6.2667, lat = 44.9833; // Inundator's default center

    const tileX = ElevationService.lngToTileX(lng, zoom);
    const tileY = ElevationService.latToTileY(lat, zoom);

    // Convert back to lng/lat from tile coordinates and check we land within
    // one tile's width/height of the original point
    const n = 2 ** zoom;
    const decodedLng = (tileX / n) * 360 - 180;
    const decodedLat = Math.atan(Math.sinh(Math.PI * (1 - 2 * tileY / n))) * 180 / Math.PI;

    const tileWidthDeg = 360 / n;
    assert.ok(Math.abs(decodedLng - lng) <= tileWidthDeg, `lng ${decodedLng} within one tile of ${lng}`);
    assert.ok(Math.abs(decodedLat - lat) <= tileWidthDeg, `lat ${decodedLat} within one tile of ${lat}`);
});

test('lngToTileX increases monotonically with longitude', () => {
    const zoom = 12;
    const x1 = ElevationService.lngToTileX(-10, zoom);
    const x2 = ElevationService.lngToTileX(0, zoom);
    const x3 = ElevationService.lngToTileX(10, zoom);
    assert.ok(x1 < x2);
    assert.ok(x2 < x3);
});

test('latToTileY decreases as latitude increases (north is up, tile Y grows downward)', () => {
    const zoom = 12;
    const yNorth = ElevationService.latToTileY(60, zoom);
    const yEquator = ElevationService.latToTileY(0, zoom);
    const ySouth = ElevationService.latToTileY(-60, zoom);
    assert.ok(yNorth < yEquator);
    assert.ok(yEquator < ySouth);
});
