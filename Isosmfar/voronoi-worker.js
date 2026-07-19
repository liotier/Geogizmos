// Web Worker for Voronoi computation
// Runs coalescing + Delaunay/Voronoi + boundary clipping off the main thread

importScripts(
    'https://cdn.jsdelivr.net/npm/@turf/turf@7/turf.min.js',
    'https://cdn.jsdelivr.net/npm/d3-delaunay@6'
);

function coalescePoints(features, distanceKm) {
    if (distanceKm === 0 || features.length === 0) {
        return features;
    }

    // Work in a local equirectangular approximation (km) rather than raw
    // degrees, so the coalesce distance is isotropic - a degree of longitude
    // covers less ground distance than a degree of latitude away from the
    // equator, and a plain degree-based threshold would ignore that.
    let sumLat = 0;
    for (const f of features) sumLat += f.lat;
    const meanLat = sumLat / features.length;
    const cosLat = Math.max(0.01, Math.cos(meanLat * Math.PI / 180)); // clamp near poles
    const kmPerDegLat = 111.0;
    const kmPerDegLon = 111.0 * cosLat;

    const points = features.map(f => ({ x: f.lon * kmPerDegLon, y: f.lat * kmPerDegLat }));

    const distSq = distanceKm * distanceKm;
    const cellSize = distanceKm;
    const grid = new Map();

    const cellKey = (cx, cy) => `${cx},${cy}`;

    for (let i = 0; i < points.length; i++) {
        const cx = Math.floor(points[i].x / cellSize);
        const cy = Math.floor(points[i].y / cellSize);
        const key = cellKey(cx, cy);
        if (!grid.has(key)) grid.set(key, []);
        grid.get(key).push(i);
    }

    const parent = new Int32Array(features.length);
    const rank = new Uint8Array(features.length);
    for (let i = 0; i < features.length; i++) parent[i] = i;

    function find(x) {
        while (parent[x] !== x) {
            parent[x] = parent[parent[x]];
            x = parent[x];
        }
        return x;
    }

    function union(a, b) {
        a = find(a);
        b = find(b);
        if (a === b) return;
        if (rank[a] < rank[b]) { const t = a; a = b; b = t; }
        parent[b] = a;
        if (rank[a] === rank[b]) rank[a]++;
    }

    for (const [key, indices] of grid) {
        const parts = key.split(',');
        const cx = Number.parseInt(parts[0]);
        const cy = Number.parseInt(parts[1]);

        for (let a = 0; a < indices.length; a++) {
            for (let b = a + 1; b < indices.length; b++) {
                const pa = points[indices[a]];
                const pb = points[indices[b]];
                const dx0 = pa.x - pb.x;
                const dy0 = pa.y - pb.y;
                if (dx0 * dx0 + dy0 * dy0 <= distSq) {
                    union(indices[a], indices[b]);
                }
            }
        }

        for (let dx = 0; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
                if (dx === 0 && dy <= 0) continue;
                const neighborKey = cellKey(cx + dx, cy + dy);
                const neighborIndices = grid.get(neighborKey);
                if (!neighborIndices) continue;

                for (const i of indices) {
                    for (const j of neighborIndices) {
                        const pi = points[i];
                        const pj = points[j];
                        const dx0 = pi.x - pj.x;
                        const dy0 = pi.y - pj.y;
                        if (dx0 * dx0 + dy0 * dy0 <= distSq) {
                            union(i, j);
                        }
                    }
                }
            }
        }
    }

    const clusterMap = new Map();
    for (let i = 0; i < features.length; i++) {
        const root = find(i);
        if (!clusterMap.has(root)) clusterMap.set(root, { sumLat: 0, sumLon: 0, count: 0 });
        const c = clusterMap.get(root);
        c.sumLat += features[i].lat;
        c.sumLon += features[i].lon;
        c.count++;
    }

    const coalescedFeatures = [];
    for (const { sumLat, sumLon, count } of clusterMap.values()) {
        coalescedFeatures.push({ lat: sumLat / count, lon: sumLon / count });
    }
    return coalescedFeatures;
}

function computeVoronoi(features, bounds, boundary, voronoiCoalesceKm) {
    const coalescedFeatures = coalescePoints(features, voronoiCoalesceKm);

    const coalesceInfo = voronoiCoalesceKm > 0
        ? `${features.length} points → ${coalescedFeatures.length} clusters`
        : '';

    const points = coalescedFeatures.map(f => [f.lon, f.lat]);

    if (points.length < 3) {
        return {
            voronoiGeoJSON: { type: 'FeatureCollection', features: [] },
            coalescedFeatures,
            coalesceInfo
        };
    }

    const delaunay = d3.Delaunay.from(points);
    const voronoi = delaunay.voronoi(bounds);

    let boundaryFeature = null;
    try {
        if (boundary.type === 'Polygon') {
            boundaryFeature = turf.polygon(boundary.coordinates);
        } else if (boundary.type === 'MultiPolygon') {
            boundaryFeature = turf.multiPolygon(boundary.coordinates);
        }
    } catch (e) {
        // proceed without boundary clipping
    }

    const lineFeatures = [];
    const processedEdges = new Set();

    for (let i = 0; i < points.length; i++) {
        const cell = voronoi.cellPolygon(i);
        if (cell && cell.length > 2) {
            try {
                const cellCoords = [...cell];
                if (cellCoords[0][0] !== cellCoords.at(-1)[0] ||
                    cellCoords[0][1] !== cellCoords.at(-1)[1]) {
                    cellCoords.push(cellCoords[0]);
                }

                const cellPolygon = turf.polygon([cellCoords]);

                let clippedCell = null;
                if (boundaryFeature) {
                    try {
                        if (turf.booleanWithin(cellPolygon, boundaryFeature)) {
                            clippedCell = cellPolygon;
                        } else {
                            const intersection = turf.intersect(turf.featureCollection([cellPolygon, boundaryFeature]));
                            if (intersection && intersection.geometry) {
                                clippedCell = intersection;
                            } else {
                                continue;
                            }
                        }
                    } catch (clipError) {
                        console.warn('Error clipping Voronoi cell to boundary:', clipError);
                        clippedCell = cellPolygon;
                    }
                } else {
                    clippedCell = cellPolygon;
                }

                if (clippedCell && clippedCell.geometry) {
                    let polygons;
                    if (clippedCell.geometry.type === 'Polygon') {
                        polygons = [clippedCell.geometry.coordinates];
                    } else if (clippedCell.geometry.type === 'MultiPolygon') {
                        polygons = clippedCell.geometry.coordinates;
                    } else {
                        continue;
                    }

                    for (const polygonRings of polygons) {
                        const exteriorRing = polygonRings[0];

                        for (let j = 0; j < exteriorRing.length - 1; j++) {
                            const p1 = exteriorRing[j];
                            const p2 = exteriorRing[j + 1];

                            const x1 = Math.round(p1[0] * 1e6);
                            const y1 = Math.round(p1[1] * 1e6);
                            const x2 = Math.round(p2[0] * 1e6);
                            const y2 = Math.round(p2[1] * 1e6);
                            const edgeKey = x1 < x2 || (x1 === x2 && y1 < y2)
                                ? `${x1},${y1},${x2},${y2}`
                                : `${x2},${y2},${x1},${y1}`;

                            if (!processedEdges.has(edgeKey)) {
                                processedEdges.add(edgeKey);
                                lineFeatures.push({
                                    type: 'Feature',
                                    geometry: {
                                        type: 'LineString',
                                        coordinates: [p1, p2]
                                    }
                                });
                            }
                        }
                    }
                }
            } catch (e) {
                // skip problematic cell
            }
        }
    }

    return {
        voronoiGeoJSON: { type: 'FeatureCollection', features: lineFeatures },
        coalescedFeatures,
        coalesceInfo
    };
}

self.onmessage = function(e) {
    const { features, bounds, boundary, voronoiCoalesceKm, requestId } = e.data;
    const result = computeVoronoi(features, bounds, boundary, voronoiCoalesceKm);
    result.requestId = requestId;
    self.postMessage(result);
};
