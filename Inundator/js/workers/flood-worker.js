/**
 * Flood Fill Worker
 * Improved physics-based flooding algorithm
 */

// Worker configuration
const CONFIG = {
    maxIterations: 20000000,  // Increased 10x for massive valley lakes
    maxDebugMessages: 100,    // Reduced to minimize overhead
    progressUpdateInterval: 100000,  // Less frequent updates = faster computation
    edgeProximityThreshold: 100,  // Cells from edge to trigger expansion
    noDataValue: -9999,
    minBodySize: 100,
    maxBodySize: 2000000,     // Increased 10x for massive reservoirs
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

/**
 * Min-heap priority queue for efficient flood-fill
 * Provides O(log n) insertion and extraction instead of O(n log n) sorting
 */
class MinHeap {
    constructor() {
        this.heap = [];
    }

    get length() {
        return this.heap.length;
    }

    push(item) {
        this.heap.push(item);
        this._bubbleUp(this.heap.length - 1);
    }

    shift() {
        if (this.heap.length === 0) return undefined;
        if (this.heap.length === 1) return this.heap.pop();

        const min = this.heap[0];
        this.heap[0] = this.heap.pop();
        this._bubbleDown(0);
        return min;
    }

    _bubbleUp(index) {
        while (index > 0) {
            const parentIndex = Math.floor((index - 1) / 2);
            if (this.heap[index].elevation >= this.heap[parentIndex].elevation) break;

            // Swap using destructuring (faster)
            [this.heap[index], this.heap[parentIndex]] = [this.heap[parentIndex], this.heap[index]];

            index = parentIndex;
        }
    }

    _bubbleDown(index) {
        while (true) {
            const leftChild = 2 * index + 1;
            const rightChild = 2 * index + 2;
            let smallest = index;

            if (leftChild < this.heap.length &&
                this.heap[leftChild].elevation < this.heap[smallest].elevation) {
                smallest = leftChild;
            }

            if (rightChild < this.heap.length &&
                this.heap[rightChild].elevation < this.heap[smallest].elevation) {
                smallest = rightChild;
            }

            if (smallest === index) break;

            // Swap using destructuring (faster)
            [this.heap[index], this.heap[smallest]] = [this.heap[smallest], this.heap[index]];

            index = smallest;
        }
    }
}

self.addEventListener('message', function (e) {
    try {
        const { demData, damCells, crestElevation } = e.data;

        self.postMessage({ progress: 0.1 });

        debugLog(`Worker initialized: ${demData.width}x${demData.height} grid, crest: ${crestElevation.toFixed(1)}m`);

        const flooded = performPhysicsBasedFlood(demData, damCells, crestElevation);

        self.postMessage({ flooded: Array.from(flooded) });
    } catch (error) {
        self.postMessage({
            error: 'Worker error: ' + error.toString() + ' at ' + error.stack
        });
    }
});

/**
 * Physics-based flood algorithm using min-heap priority queue
 * Water flows from high to low elevation, accumulating in depressions
 * Prevents uphill flooding by tracking maximum elevation in flow path
 */
function performPhysicsBasedFlood(demData, damCells, crestElevation) {
    const { width, height, data } = demData;

    debugLog('Starting physics-based flood algorithm');

    // Create barrier from dam line extended to mountainside
    const barriers = extendDamToMountainside(damCells, data, width, height, crestElevation);

    // Create visited array and mark barriers
    const visited = new Uint8Array(width * height);
    for (let cell of barriers) {
        visited[cell] = 2; // 2 = barrier
    }

    // Find seed cells (adjacent to dam barriers, below crest)
    const allSeeds = findSeedCells(Array.from(barriers), barriers, data, width, height, crestElevation);

    if (allSeeds.length === 0) {
        debugLog('ERROR: No seed cells found');
        return new Set();
    }

    debugLog(`Found ${allSeeds.length} seed cells adjacent to extended dam`);

    // Partition seeds geometrically into left/right sides of dam
    const seedPartitions = partitionSeedCells(allSeeds, damCells, width, height, data);

    // Find LOWEST elevation seed on each side (valley bottom)
    let leftSeed = null;
    let leftMinElev = Infinity;
    for (let seed of seedPartitions.left) {
        const elev = data[seed];
        if (elev > CONFIG.noDataValue && elev < leftMinElev) {
            leftMinElev = elev;
            leftSeed = seed;
        }
    }

    let rightSeed = null;
    let rightMinElev = Infinity;
    for (let seed of seedPartitions.right) {
        const elev = data[seed];
        if (elev > CONFIG.noDataValue && elev < rightMinElev) {
            rightMinElev = elev;
            rightSeed = seed;
        }
    }

    debugLog(`Left valley bottom: seed at ${leftMinElev.toFixed(1)}m, Right valley bottom: seed at ${rightMinElev.toFixed(1)}m`);

    // Priority queue-based flooding from both valley bottoms
    const flooded = new Set();
    const queue = new MinHeap();

    // Add starting seeds
    if (leftSeed !== null) {
        flooded.add(leftSeed);
        visited[leftSeed] = 1;
        queue.push({
            cell: leftSeed,
            elevation: data[leftSeed]
        });
    }
    if (rightSeed !== null) {
        flooded.add(rightSeed);
        visited[rightSeed] = 1;
        queue.push({
            cell: rightSeed,
            elevation: data[rightSeed]
        });
    }

    debugLog(`Starting physics-based flood from 2 valley bottom seeds`);

    let iterations = 0;
    let lastEdgeCheck = 0;
    const edgeCheckInterval = 10000;  // Check for edge proximity every N iterations

    while (queue.length > 0 && iterations < CONFIG.maxIterations) {
        iterations++;

        if (iterations % CONFIG.progressUpdateInterval === 0) {
            debugLog(`Iteration ${iterations}, queue: ${queue.length}, flooded: ${flooded.size}`);
            self.postMessage({ progress: 0.1 + (iterations / CONFIG.maxIterations) * 0.4 });
        }

        // Periodically check if flooding is approaching DEM edge
        if (iterations - lastEdgeCheck >= edgeCheckInterval) {
            lastEdgeCheck = iterations;
            if (isApproachingEdge(flooded, width, height)) {
                debugLog(`Flooding approaching DEM edge at ${flooded.size} cells - requesting expansion`);
                self.postMessage({
                    needMoreDEM: true,
                    currentSize: flooded.size,
                    iterations: iterations
                });
                return new Set();  // Return empty, will restart with larger DEM
            }
        }

        // Extract lowest elevation cell from min-heap (O(log n) instead of O(n log n) sort)
        const current = queue.shift();
        const { cell, elevation: currentElev } = current;

        // Get neighbors
        const neighbors = getNeighbors(cell, width, height);

        for (let neighbor of neighbors) {
            // Skip if already processed or is a barrier
            if (visited[neighbor] !== 0) continue;

            const neighborElev = data[neighbor];

            // Skip no-data cells and cells that are too high (optimization)
            if (neighborElev <= CONFIG.noDataValue || neighborElev >= crestElevation) continue;

            // Physics-based check: water can only reach neighbor if path stays below crest
            // Water level = max elevation encountered in path
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

    debugLog(`Physics-based flooding complete: ${flooded.size} cells from both valleys`);

    // Identify separate water bodies using connected components
    const bodies = identifyWaterBodies(flooded, visited, width, height, data, crestElevation);

    debugLog(`Found ${bodies.length} water bodies`);

    if (bodies.length === 0) {
        return new Set();
    }

    // Whether single or multiple bodies, always partition to select upstream
    let selectedCells;

    if (bodies.length === 1) {
        debugLog('Single connected body - partitioning to select upstream side');
        const partitions = partitionByDamSide(bodies[0].cells, damCells, width, height, data, crestElevation);
        selectedCells = partitions.upstream;
        debugLog(`Upstream: ${partitions.upstream.size} cells, Downstream: ${partitions.downstream.size} cells`);
    } else {
        // Multiple bodies - select the one closest to dam center
        const damCenterX = damCells.reduce((sum, cell) => sum + (cell % width), 0) / damCells.length;
        const damCenterY = damCells.reduce((sum, cell) => sum + Math.floor(cell / width), 0) / damCells.length;

        let bestBody = bodies[0];
        let minDist = Infinity;

        for (let body of bodies) {
            const distX = body.centerX - damCenterX;
            const distY = body.centerY - damCenterY;
            const dist = Math.sqrt(distX * distX + distY * distY);

            if (dist < minDist) {
                minDist = dist;
                bestBody = body;
            }
        }

        debugLog(`Selected body ${bestBody.id} (${bestBody.size} cells, dist=${minDist.toFixed(1)} from dam)`);
        selectedCells = bestBody.cells;
    }

    return selectedCells;
}

/**
 * Partition seed cells by which side of the dam they're on
 * Just geometric partitioning - doesn't try to determine upstream
 */
function partitionSeedCells(seedCells, damCells, width, height, data) {
    if (damCells.length < 2) {
        debugLog('WARNING: Dam too short to partition seeds');
        return { left: new Set(seedCells), right: new Set() };
    }

    // Calculate dam line vector
    const firstCell = damCells[0];
    const lastCell = damCells[damCells.length - 1];
    const x1 = firstCell % width;
    const y1 = Math.floor(firstCell / width);
    const x2 = lastCell % width;
    const y2 = Math.floor(lastCell / width);

    const damVectorX = x2 - x1;
    const damVectorY = y2 - y1;

    // Partition seeds by side using cross product
    const leftSeeds = new Set();
    const rightSeeds = new Set();

    for (let cell of seedCells) {
        const x = cell % width;
        const y = Math.floor(cell / width);

        // Cross product determines side
        const toCellX = x - x1;
        const toCellY = y - y1;
        const crossProduct = damVectorX * toCellY - damVectorY * toCellX;

        if (crossProduct > 0) {
            leftSeeds.add(cell);
        } else if (crossProduct < 0) {
            rightSeeds.add(cell);
        }
        // crossProduct === 0 means on the line (rare)
    }

    debugLog(`Geometric partition: Left=${leftSeeds.size} seeds, Right=${rightSeeds.size} seeds`);

    return { left: leftSeeds, right: rightSeeds };
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
    let leftMaxElev = -Infinity;
    let rightMaxElev = -Infinity;
    let leftMinElev = Infinity;
    let rightMinElev = Infinity;
    let leftCount = 0;
    let rightCount = 0;
    let leftTouchesEdge = false;
    let rightTouchesEdge = false;

    for (let cell of flooded) {
        const x = cell % width;
        const y = Math.floor(cell / width);
        const elevation = data[cell];

        if (elevation <= CONFIG.noDataValue) continue;

        // Check if cell touches edge
        const touchesEdge = (x === 0 || x === width - 1 || y === 0 || y === height - 1);

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
            if (elevation > leftMaxElev) leftMaxElev = elevation;
            if (elevation < leftMinElev) leftMinElev = elevation;
            if (touchesEdge) leftTouchesEdge = true;
        } else if (crossProduct < 0) {
            rightSide.add(cell);
            rightElevSum += elevation;
            rightCount++;
            if (elevation > rightMaxElev) rightMaxElev = elevation;
            if (elevation < rightMinElev) rightMinElev = elevation;
            if (touchesEdge) rightTouchesEdge = true;
        }
        // crossProduct === 0 means exactly on the line (rare, ignore)
    }

    const leftAvgElev = leftCount > 0 ? leftElevSum / leftCount : 0;
    const rightAvgElev = rightCount > 0 ? rightElevSum / rightCount : 0;

    debugLog(`Left side: ${leftSide.size} cells, min=${leftMinElev.toFixed(1)}m, avg=${leftAvgElev.toFixed(1)}m, max=${leftMaxElev.toFixed(1)}m, edge=${leftTouchesEdge}`);
    debugLog(`Right side: ${rightSide.size} cells, min=${rightMinElev.toFixed(1)}m, avg=${rightAvgElev.toFixed(1)}m, max=${rightMaxElev.toFixed(1)}m, edge=${rightTouchesEdge}`);

    // Multi-factor upstream detection
    // Score each side, higher score = more likely to be upstream
    let leftScore = 0;
    let rightScore = 0;

    // Factor 1: Minimum elevation (valley floor) - upstream floor is higher
    // This is the most reliable indicator
    const minElevDiff = leftMinElev - rightMinElev;
    if (Math.abs(minElevDiff) > 5) {  // Significant difference (>5m)
        if (minElevDiff > 0) {
            leftScore += 100;  // Left has higher valley floor
            debugLog(`Left valley floor ${minElevDiff.toFixed(1)}m higher (+100 points)`);
        } else {
            rightScore += 100;  // Right has higher valley floor
            debugLog(`Right valley floor ${Math.abs(minElevDiff).toFixed(1)}m higher (+100 points)`);
        }
    }

    // Factor 2: Average elevation - upstream should be higher
    const avgElevDiff = leftAvgElev - rightAvgElev;
    if (Math.abs(avgElevDiff) > 10) {  // Significant difference (>10m)
        if (avgElevDiff > 0) {
            leftScore += 50;
            debugLog(`Left avg elevation ${avgElevDiff.toFixed(1)}m higher (+50 points)`);
        } else {
            rightScore += 50;
            debugLog(`Right avg elevation ${Math.abs(avgElevDiff).toFixed(1)}m higher (+50 points)`);
        }
    }

    // Factor 3: Edge touching - downstream more likely to extend to edge
    if (leftTouchesEdge && !rightTouchesEdge) {
        rightScore += 75;
        debugLog('Only left touches edge, right likely upstream (+75 points)');
    } else if (rightTouchesEdge && !leftTouchesEdge) {
        leftScore += 75;
        debugLog('Only right touches edge, left likely upstream (+75 points)');
    }

    // Factor 4: Size - upstream is typically smaller (more confined)
    // Only use as weak tiebreaker
    const sizeDiff = Math.abs(leftSide.size - rightSide.size);
    const sizeRatio = Math.max(leftSide.size, rightSide.size) / Math.min(leftSide.size, rightSide.size);
    if (sizeRatio > 2) {  // One side is significantly larger
        if (leftSide.size < rightSide.size) {
            leftScore += 25;
            debugLog(`Left is smaller/more confined (+25 points)`);
        } else {
            rightScore += 25;
            debugLog(`Right is smaller/more confined (+25 points)`);
        }
    }

    debugLog(`Final scores: Left=${leftScore}, Right=${rightScore}`);

    // Select upstream based on score
    let upstream, downstream;
    if (leftScore > rightScore) {
        debugLog('Left side selected as upstream');
        upstream = leftSide;
        downstream = rightSide;
    } else if (rightScore > leftScore) {
        debugLog('Right side selected as upstream');
        upstream = rightSide;
        downstream = leftSide;
    } else {
        // Tie - fall back to size
        if (leftSide.size < rightSide.size) {
            debugLog('Tie - left side selected as upstream (smaller)');
            upstream = leftSide;
            downstream = rightSide;
        } else {
            debugLog('Tie - right side selected as upstream (smaller)');
            upstream = rightSide;
            downstream = leftSide;
        }
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
 * Extend dam parallel to itself from both endpoints until hitting mountainside
 * "Prolong the dam on both sides until each side hits a cell whose altitude
 * is more than the dam's highest extremity"
 */
function extendDamToMountainside(damCells, data, width, height, crestElevation) {
    if (damCells.length < 2) {
        debugLog('Dam too short to extend');
        return createDamBarrier(damCells, width, height);
    }

    // Start with thickened dam barrier
    const barriers = createDamBarrier(damCells, width, height);

    // Calculate dam direction vector
    const firstCell = damCells[0];
    const lastCell = damCells[damCells.length - 1];
    const x1 = firstCell % width;
    const y1 = Math.floor(firstCell / width);
    const x2 = lastCell % width;
    const y2 = Math.floor(lastCell / width);

    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.sqrt(dx * dx + dy * dy);

    if (len === 0) {
        debugLog('Dam has zero length');
        return barriers;
    }

    // Normalized direction vector
    const dirX = dx / len;
    const dirY = dy / len;

    debugLog(`Dam direction: (${dirX.toFixed(3)}, ${dirY.toFixed(3)}), extending until hitting mountainside > ${crestElevation.toFixed(1)}m`);

    // Extend from first endpoint BACKWARD (opposite direction)
    let extCount1 = 0;
    let currentX = x1;
    let currentY = y1;

    for (let i = 0; i < 1000; i++) {  // Max 1000 cells for large valleys
        currentX -= dirX;
        currentY -= dirY;

        const x = Math.round(currentX);
        const y = Math.round(currentY);

        // Check bounds
        if (x < 0 || x >= width || y < 0 || y >= height) break;

        const cell = y * width + x;
        const elevation = data[cell];

        // Stop if we hit mountainside (elevation > crest)
        if (elevation > crestElevation) {
            debugLog(`Hit mountainside at endpoint 1 after ${extCount1} cells (elev: ${elevation.toFixed(1)}m)`);
            break;
        }

        // Stop if no-data
        if (elevation <= CONFIG.noDataValue) break;

        barriers.add(cell);
        extCount1++;
    }

    // Extend from last endpoint FORWARD
    let extCount2 = 0;
    currentX = x2;
    currentY = y2;

    for (let i = 0; i < 1000; i++) {  // Max 1000 cells for large valleys
        currentX += dirX;
        currentY += dirY;

        const x = Math.round(currentX);
        const y = Math.round(currentY);

        // Check bounds
        if (x < 0 || x >= width || y < 0 || y >= height) break;

        const cell = y * width + x;
        const elevation = data[cell];

        // Stop if we hit mountainside (elevation > crest)
        if (elevation > crestElevation) {
            debugLog(`Hit mountainside at endpoint 2 after ${extCount2} cells (elev: ${elevation.toFixed(1)}m)`);
            break;
        }

        // Stop if no-data
        if (elevation <= CONFIG.noDataValue) break;

        barriers.add(cell);
        extCount2++;
    }

    debugLog(`Dam extended: +${extCount1} cells from start, +${extCount2} cells from end (total ${barriers.size} barrier cells)`);

    return barriers;
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

/**
 * Check if flooding is approaching DEM edge
 * Returns true if any flooded cells are within threshold distance of edge
 */
function isApproachingEdge(flooded, width, height) {
    const threshold = CONFIG.edgeProximityThreshold;

    for (let cell of flooded) {
        const x = cell % width;
        const y = Math.floor(cell / width);

        if (x < threshold || x >= width - threshold ||
            y < threshold || y >= height - threshold) {
            return true;
        }
    }

    return false;
}
