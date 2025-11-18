/**
 * Flood Fill Worker
 * Improved physics-based flooding algorithm
 */

// Worker configuration
const CONFIG = {
    maxIterations: 1000000,  // Increased to allow large reservoirs to fully flood
    maxDebugMessages: 200,
    progressUpdateInterval: 10000,  // Less frequent updates for large floods
    noDataValue: -9999,
    minBodySize: 100,
    maxBodySize: 100000,
    elevationWeight: 2.0,
    edgePenalty: 10000,
    distancePenalty: 0.5,
    smallSizePenalty: 1000,
    largeSizePenalty: 2000
};

let debugMessageCount = 0;

function debugLog(msg) {
    if (debugMessageCount < CONFIG.maxDebugMessages) {
        debugMessageCount++;
        self.postMessage({ debug: msg });
    }
}

self.addEventListener('message', function (e) {
    try {
        const { demData, damCells, crestElevation, usePhysics } = e.data;

        self.postMessage({ progress: 0.1 });

        debugLog(`Worker initialized: ${demData.width}x${demData.height} grid, crest: ${crestElevation.toFixed(1)}m`);

        let flooded;
        if (usePhysics) {
            flooded = performPhysicsBasedFlood(demData, damCells, crestElevation);
        } else {
            flooded = performSimpleFloodFill(demData, damCells, crestElevation);
        }

        self.postMessage({ flooded: Array.from(flooded) });
    } catch (error) {
        self.postMessage({
            error: 'Worker error: ' + error.toString() + ' at ' + error.stack
        });
    }
});

/**
 * IMPROVED: Physics-based flood algorithm using priority queue
 * Water flows from high to low elevation, accumulating in depressions
 */
function performPhysicsBasedFlood(demData, damCells, crestElevation) {
    const { width, height, data } = demData;

    debugLog('Starting physics-based flood algorithm');

    // Create barrier from dam line
    const barriers = createDamBarrier(damCells, width, height);

    // Find seed cells (adjacent to dam, below crest)
    const seeds = findSeedCells(damCells, barriers, data, width, height, crestElevation);

    if (seeds.length === 0) {
        debugLog('ERROR: No seed cells found');
        return new Set();
    }

    debugLog(`Found ${seeds.length} seed cells`);

    // Priority queue-based flooding
    // Water spreads to lowest available neighbors first
    const flooded = new Set();
    const visited = new Uint8Array(width * height);

    // Mark barriers as visited
    for (let cell of barriers) {
        visited[cell] = 2; // 2 = barrier
    }

    // Priority queue: [elevation, cell]
    // Use simple array and sort (good enough for moderate sizes)
    const queue = seeds.map(cell => ({
        cell,
        elevation: data[cell]
    }));

    // Mark seeds as flooded
    for (let seed of seeds) {
        flooded.add(seed);
        visited[seed] = 1;
    }

    let iterations = 0;

    while (queue.length > 0 && iterations < CONFIG.maxIterations) {
        iterations++;

        if (iterations % CONFIG.progressUpdateInterval === 0) {
            debugLog(`Iteration ${iterations}, queue: ${queue.length}, flooded: ${flooded.size}`);
            self.postMessage({ progress: 0.1 + (iterations / CONFIG.maxIterations) * 0.4 });
        }

        // Sort queue by elevation (ascending)
        // Water fills lowest areas first
        queue.sort((a, b) => a.elevation - b.elevation);

        // Process lowest elevation cell
        const current = queue.shift();
        const { cell, elevation: currentElev } = current;

        // Get neighbors
        const neighbors = getNeighbors(cell, width, height);

        for (let neighbor of neighbors) {
            // Skip if already processed or is a barrier
            if (visited[neighbor] !== 0) continue;

            const neighborElev = data[neighbor];

            // Skip no-data cells
            if (neighborElev <= CONFIG.noDataValue) continue;

            // Check if water can reach this cell
            // Water spreads to cells below crest elevation
            // Key improvement: water level is determined by highest point in path
            const waterLevel = Math.max(currentElev, neighborElev);

            if (waterLevel < crestElevation) {
                visited[neighbor] = 1;
                flooded.add(neighbor);
                queue.push({
                    cell: neighbor,
                    elevation: neighborElev
                });
            }
        }
    }

    if (iterations >= CONFIG.maxIterations) {
        debugLog(`WARNING: Reached iteration limit at ${flooded.size} cells`);
    }

    debugLog(`Physics-based flooding complete: ${flooded.size} cells`);

    // CRITICAL FIX: Partition flooded cells by which side of dam they're on
    // This prevents water from flooding both upstream and downstream simultaneously
    const partitions = partitionByDamSide(flooded, damCells, width, height, data, crestElevation);

    if (partitions.upstream.size === 0 && partitions.downstream.size === 0) {
        debugLog('ERROR: No valid partitions found');
        return new Set();
    }

    // Return only the upstream side (the actual reservoir)
    debugLog(`Upstream: ${partitions.upstream.size} cells, Downstream: ${partitions.downstream.size} cells`);
    return partitions.upstream;
}

/**
 * LEGACY: Simple threshold-based flood fill (original algorithm)
 * Kept for comparison/fallback
 */
function performSimpleFloodFill(demData, damCells, crestElevation) {
    const { width, height, data } = demData;

    debugLog('Starting simple flood-fill algorithm (legacy)');

    // Create barrier from dam line
    const visited = new Uint8Array(width * height);

    // Mark dam cells as barriers
    for (let cell of damCells) {
        visited[cell] = 2;
    }

    // DON'T extend dam to edges - it creates infinite barrier walls
    // Instead, rely on water body selection to pick upstream vs downstream
    // extendDamToEdges(damCells, visited, width, height);

    // Find seed cells
    const flooded = new Set();
    const queue = [];

    for (let damCell of damCells) {
        const neighbors = getNeighbors(damCell, width, height);

        for (let neighbor of neighbors) {
            if (visited[neighbor] !== 0) continue;

            const elevation = data[neighbor];

            if (elevation > CONFIG.noDataValue && elevation < crestElevation) {
                queue.push(neighbor);
                visited[neighbor] = 1;
                flooded.add(neighbor);
            }
        }
    }

    debugLog(`Found ${flooded.size} seed cells`);

    // Simple BFS flood fill
    let iterations = 0;

    while (queue.length > 0 && iterations < CONFIG.maxIterations) {
        iterations++;

        if (iterations % CONFIG.progressUpdateInterval === 0) {
            debugLog(`Iteration ${iterations}, queue: ${queue.length}, flooded: ${flooded.size}`);
        }

        const cell = queue.shift();
        const neighbors = getNeighbors(cell, width, height);

        for (let neighbor of neighbors) {
            if (visited[neighbor] !== 0) continue;

            const neighborElev = data[neighbor];

            if (neighborElev > CONFIG.noDataValue && neighborElev < crestElevation) {
                visited[neighbor] = 1;
                flooded.add(neighbor);
                queue.push(neighbor);
            }
        }
    }

    debugLog(`Simple flooding complete: ${flooded.size} cells`);

    // CRITICAL FIX: Partition flooded cells by which side of dam they're on
    // This prevents water from flooding both upstream and downstream simultaneously
    const partitions = partitionByDamSide(flooded, damCells, width, height, data, crestElevation);

    if (partitions.upstream.size === 0 && partitions.downstream.size === 0) {
        debugLog('ERROR: No valid partitions found');
        return new Set();
    }

    // Return only the upstream side (the actual reservoir)
    debugLog(`Upstream: ${partitions.upstream.size} cells, Downstream: ${partitions.downstream.size} cells`);
    return partitions.upstream;
}

/**
 * Partition flooded cells by which side of the dam they're on
 * Uses geometric calculation (cross product) to determine left vs right
 * Returns upstream (higher elevation) side only
 */
function partitionByDamSide(flooded, damCells, width, height, data, crestElevation) {
    if (damCells.length < 2) {
        debugLog('WARNING: Dam too short to partition, returning all flooded cells as upstream');
        return { upstream: flooded, downstream: new Set() };
    }

    // Calculate dam line vector from first to last point
    const firstCell = damCells[0];
    const lastCell = damCells[damCells.length - 1];
    const x1 = firstCell % width;
    const y1 = Math.floor(firstCell / width);
    const x2 = lastCell % width;
    const y2 = Math.floor(lastCell / width);

    // Dam vector
    const damVectorX = x2 - x1;
    const damVectorY = y2 - y1;

    debugLog(`Dam line: (${x1},${y1}) to (${x2},${y2}), vector: (${damVectorX},${damVectorY})`);

    // Partition flooded cells by side
    const leftSide = new Set();
    const rightSide = new Set();
    let leftElevSum = 0;
    let rightElevSum = 0;
    let leftCount = 0;
    let rightCount = 0;

    for (let cell of flooded) {
        const x = cell % width;
        const y = Math.floor(cell / width);
        const elevation = data[cell];

        if (elevation <= CONFIG.noDataValue) continue;

        // Vector from dam start to this cell
        const toCellX = x - x1;
        const toCellY = y - y1;

        // Cross product determines which side
        // Positive = left side, Negative = right side
        const crossProduct = damVectorX * toCellY - damVectorY * toCellX;

        if (crossProduct > 0) {
            leftSide.add(cell);
            leftElevSum += elevation;
            leftCount++;
        } else if (crossProduct < 0) {
            rightSide.add(cell);
            rightElevSum += elevation;
            rightCount++;
        }
        // crossProduct === 0 means exactly on the line (rare, ignore)
    }

    const leftAvgElev = leftCount > 0 ? leftElevSum / leftCount : 0;
    const rightAvgElev = rightCount > 0 ? rightElevSum / rightCount : 0;

    debugLog(`Left side: ${leftSide.size} cells, avgElev: ${leftAvgElev.toFixed(1)}m`);
    debugLog(`Right side: ${rightSide.size} cells, avgElev: ${rightAvgElev.toFixed(1)}m`);

    // Upstream side has HIGHER average elevation (water accumulates behind dam at higher altitude)
    let upstream, downstream;
    if (leftAvgElev > rightAvgElev) {
        debugLog('Left side selected as upstream (higher elevation)');
        upstream = leftSide;
        downstream = rightSide;
    } else {
        debugLog('Right side selected as upstream (higher elevation)');
        upstream = rightSide;
        downstream = leftSide;
    }

    // Additional validation: check if upstream is too small (might indicate algorithm error)
    if (upstream.size < CONFIG.minBodySize && downstream.size >= CONFIG.minBodySize) {
        debugLog(`WARNING: Upstream very small (${upstream.size} cells), might be misidentified. Swapping.`);
        const temp = upstream;
        upstream = downstream;
        downstream = temp;
    }

    return { upstream, downstream };
}

/**
 * Create barrier wall from dam cells
 */
function createDamBarrier(damCells, width, height) {
    const barriers = new Set(damCells);

    // Thicken dam line to ensure continuous barrier
    for (let i = 0; i < damCells.length - 1; i++) {
        const cell1 = damCells[i];
        const cell2 = damCells[i + 1];
        const x1 = cell1 % width;
        const y1 = Math.floor(cell1 / width);
        const x2 = cell2 % width;
        const y2 = Math.floor(cell2 / width);

        const steps = Math.max(Math.abs(x2 - x1), Math.abs(y2 - y1));

        for (let s = 0; s <= steps; s++) {
            const t = s / steps;
            const x = Math.round(x1 + (x2 - x1) * t);
            const y = Math.round(y1 + (y2 - y1) * t);
            const cell = y * width + x;

            if (cell >= 0 && cell < width * height) {
                barriers.add(cell);
            }
        }
    }

    return barriers;
}

/**
 * Extend dam minimally to create separation
 * Only extends from ENDPOINTS, not every cell
 * Limited distance, not to edges
 */
function extendDamToEdges(damCells, visited, width, height) {
    if (damCells.length < 2) return;

    const firstDam = damCells[0];
    const lastDam = damCells[damCells.length - 1];
    const x1 = firstDam % width;
    const y1 = Math.floor(firstDam / width);
    const x2 = lastDam % width;
    const y2 = Math.floor(lastDam / width);

    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.sqrt(dx * dx + dy * dy);

    if (len === 0) return;

    // Calculate perpendicular direction
    const perpX = -dy / len;
    const perpY = dx / len;

    // MINIMAL extension - just 50 cells from each endpoint
    const maxExtension = 50;

    debugLog(`Minimal barrier extension from endpoints (max ${maxExtension} cells each direction)`);

    // Extend from FIRST endpoint only
    let extX = x1;
    let extY = y1;

    // Try +perpendicular
    for (let i = 0; i < maxExtension; i++) {
        extX += perpX;
        extY += perpY;

        if (extX < 0 || extX >= width || extY < 0 || extY >= height) break;

        const cell = Math.floor(extY) * width + Math.floor(extX);
        if (cell >= 0 && cell < width * height) {
            visited[cell] = 2;
        }
    }

    // Try -perpendicular from first endpoint
    extX = x1;
    extY = y1;
    for (let i = 0; i < maxExtension; i++) {
        extX -= perpX;
        extY -= perpY;

        if (extX < 0 || extX >= width || extY < 0 || extY >= height) break;

        const cell = Math.floor(extY) * width + Math.floor(extX);
        if (cell >= 0 && cell < width * height) {
            visited[cell] = 2;
        }
    }

    debugLog('Minimal barrier created from endpoints');
}

/**
 * Find seed cells adjacent to dam
 */
function findSeedCells(damCells, barriers, data, width, height, crestElevation) {
    const seeds = [];
    const seenSeeds = new Set();

    // Check direct neighbors first
    for (let damCell of damCells) {
        const neighbors = getNeighbors(damCell, width, height);

        for (let neighbor of neighbors) {
            if (barriers.has(neighbor) || seenSeeds.has(neighbor)) continue;

            const elevation = data[neighbor];

            if (elevation > CONFIG.noDataValue && elevation < crestElevation) {
                seeds.push(neighbor);
                seenSeeds.add(neighbor);
            }
        }
    }

    // If no seeds found, search 2 cells away
    if (seeds.length === 0) {
        debugLog('No direct seeds found, searching 2 cells away');

        for (let damCell of damCells) {
            const damX = damCell % width;
            const damY = Math.floor(damCell / width);

            for (let dx = -2; dx <= 2; dx++) {
                for (let dy = -2; dy <= 2; dy++) {
                    if (Math.abs(dx) !== 2 && Math.abs(dy) !== 2) continue;

                    const x = damX + dx;
                    const y = damY + dy;

                    if (x >= 0 && x < width && y >= 0 && y < height) {
                        const cell = y * width + x;

                        if (!barriers.has(cell) && !seenSeeds.has(cell)) {
                            const elevation = data[cell];

                            if (elevation > CONFIG.noDataValue && elevation < crestElevation) {
                                seeds.push(cell);
                                seenSeeds.add(cell);
                            }
                        }
                    }
                }
            }
        }
    }

    return seeds;
}

/**
 * Identify separate water bodies using connected components
 */
function identifyWaterBodies(flooded, visited, width, height, data, crestElevation) {
    const bodies = [];
    const assigned = new Set();
    let bodyId = 0;

    for (let floodedCell of flooded) {
        if (assigned.has(floodedCell)) continue;

        bodyId++;
        const bodyCells = new Set();
        const queue = [floodedCell];
        bodyCells.add(floodedCell);
        assigned.add(floodedCell);

        let totalDepth = 0;
        let minElevation = Infinity;
        let maxElevation = -Infinity;
        let touchesEdge = false;
        let minX = width, maxX = 0, minY = height, maxY = 0;

        while (queue.length > 0) {
            const cell = queue.shift();
            const x = cell % width;
            const y = Math.floor(cell / width);

            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;

            if (x === 0 || x === width - 1 || y === 0 || y === height - 1) {
                touchesEdge = true;
            }

            const elevation = data[cell];
            if (elevation > CONFIG.noDataValue) {
                totalDepth += (crestElevation - elevation);
                if (elevation < minElevation) minElevation = elevation;
                if (elevation > maxElevation) maxElevation = elevation;
            }

            const neighbors = getNeighbors(cell, width, height);
            for (let neighbor of neighbors) {
                if (flooded.has(neighbor) && !assigned.has(neighbor)) {
                    bodyCells.add(neighbor);
                    assigned.add(neighbor);
                    queue.push(neighbor);
                }
            }
        }

        const centerX = (minX + maxX) / 2;
        const centerY = (minY + maxY) / 2;
        const avgDepth = totalDepth / bodyCells.size;

        bodies.push({
            id: bodyId,
            cells: bodyCells,
            size: bodyCells.size,
            avgDepth,
            minElevation,
            maxElevation,
            touchesEdge,
            centerX,
            centerY,
            bounds: [minX, minY, maxX, maxY]
        });

        debugLog(`Body ${bodyId}: size=${bodyCells.size}, avgDepth=${avgDepth.toFixed(1)}m, minElev=${minElevation.toFixed(1)}m, touchesEdge=${touchesEdge}`);
    }

    return bodies;
}

/**
 * Select upstream water body from multiple candidates
 */
function selectUpstreamBody(bodies, damX, damY, width, height) {
    let bestBody = bodies[0];
    let bestScore = -Infinity;

    for (let body of bodies) {
        let score = 0;

        // Prefer higher minimum elevation (upstream characteristic)
        score += body.minElevation * CONFIG.elevationWeight;

        // Penalize edge-touching (likely downstream)
        if (body.touchesEdge) {
            score -= CONFIG.edgePenalty;
        }

        // Prefer closer to dam
        const distFromDam = Math.sqrt(
            Math.pow(body.centerX - damX, 2) +
            Math.pow(body.centerY - damY, 2)
        );
        score -= distFromDam * CONFIG.distancePenalty;

        // Penalize very small bodies (artifacts)
        if (body.size < CONFIG.minBodySize) {
            score -= CONFIG.smallSizePenalty;
        }

        // Penalize very large bodies (downstream flooding)
        // BUT: If body doesn't touch edge, it's a confined reservoir (valid even if large)
        if (body.size > CONFIG.maxBodySize && body.touchesEdge) {
            score -= CONFIG.largeSizePenalty;
        }

        debugLog(`Body ${body.id} score: ${score.toFixed(1)}`);

        if (score > bestScore) {
            bestScore = score;
            bestBody = body;
        }
    }

    return bestBody;
}

/**
 * Get 4-connected neighbors
 */
function getNeighbors(cell, width, height) {
    const neighbors = [];
    const x = cell % width;
    const y = Math.floor(cell / width);

    if (x > 0) neighbors.push(cell - 1);
    if (x < width - 1) neighbors.push(cell + 1);
    if (y > 0) neighbors.push(cell - width);
    if (y < height - 1) neighbors.push(cell + width);

    return neighbors;
}
