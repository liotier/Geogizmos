/**
 * Flood Fill Worker
 * Improved physics-based flooding algorithm
 */

// Worker configuration
const CONFIG = {
    maxIterations: 100000,
    maxDebugMessages: 200,
    progressUpdateInterval: 5000,
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

    // Identify and select best water body
    const bodies = identifyWaterBodies(flooded, visited, width, height, data, crestElevation);

    if (bodies.length === 0) {
        return new Set();
    } else if (bodies.length === 1) {
        debugLog('Single water body found');
        return bodies[0].cells;
    } else {
        const avgDamX = damCells.reduce((sum, cell) => sum + (cell % width), 0) / damCells.length;
        const avgDamY = damCells.reduce((sum, cell) => sum + Math.floor(cell / width), 0) / damCells.length;

        const selected = selectUpstreamBody(bodies, avgDamX, avgDamY, width, height);
        debugLog(`Selected body ${selected.id} of ${bodies.length} as upstream reservoir`);
        return selected.cells;
    }
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

    // Extend dam to edges
    extendDamToEdges(damCells, visited, width, height);

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

    // Identify and select water bodies
    const bodies = identifyWaterBodies(flooded, visited, width, height, data, crestElevation);

    if (bodies.length === 0) {
        return new Set();
    } else if (bodies.length === 1) {
        return bodies[0].cells;
    } else {
        const avgDamX = damCells.reduce((sum, cell) => sum + (cell % width), 0) / damCells.length;
        const avgDamY = damCells.reduce((sum, cell) => sum + Math.floor(cell / width), 0) / damCells.length;

        const selected = selectUpstreamBody(bodies, avgDamX, avgDamY, width, height);
        return selected.cells;
    }
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
 * Extend dam to map edges (legacy algorithm)
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

    const dirX = dx / len;
    const dirY = dy / len;

    const maxExtensions = Math.max(width, height) * 2;

    // Extend backwards
    let extX = x1;
    let extY = y1;
    let count = 0;

    while (extX >= 0 && extX < width && extY >= 0 && extY < height && count < maxExtensions) {
        const cell = Math.floor(extY) * width + Math.floor(extX);
        if (cell >= 0 && cell < width * height) {
            visited[cell] = 2;
        }
        extX -= dirX;
        extY -= dirY;
        count++;
    }

    // Extend forwards
    extX = x2;
    extY = y2;
    count = 0;

    while (extX >= 0 && extX < width && extY >= 0 && extY < height && count < maxExtensions) {
        const cell = Math.floor(extY) * width + Math.floor(extX);
        if (cell >= 0 && cell < width * height) {
            visited[cell] = 2;
        }
        extX += dirX;
        extY += dirY;
        count++;
    }
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
        if (body.size > CONFIG.maxBodySize) {
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
