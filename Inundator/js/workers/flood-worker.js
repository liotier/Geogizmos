/**
 * Flood Fill Worker
 * Improved physics-based flooding algorithm
 */

// Worker configuration
const CONFIG = {
    maxIterations: 20000000,  // Increased 10x for massive valley lakes
    maxDebugMessages: 100,    // Reduced to minimize overhead
    progressUpdateInterval: 100000,  // Less frequent updates = faster computation
    edgeProximityThreshold: 500,  // Cells from edge to trigger expansion (increased for less aggressive expansion)
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

        // Only send completion if we got actual results (null means expansion requested)
        if (flooded !== null) {
            self.postMessage({ flooded: Array.from(flooded) });
        }
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

    // Multi-elevation seeding: Use ALL selected seeds from different elevation bands
    // This helps find upstream valleys that are topographically disconnected
    const flooded = new Set();
    const queue = new MinHeap();

    // Track elevations for logging
    let leftElevations = [];
    let rightElevations = [];

    // Add ALL seeds from both sides (not just valley bottom)
    for (let seed of seedPartitions.left) {
        const elev = data[seed];
        if (elev > CONFIG.noDataValue) {
            flooded.add(seed);
            visited[seed] = 1;
            queue.push({
                cell: seed,
                elevation: elev
            });
            leftElevations.push(elev);
        }
    }

    for (let seed of seedPartitions.right) {
        const elev = data[seed];
        if (elev > CONFIG.noDataValue) {
            flooded.add(seed);
            visited[seed] = 1;
            queue.push({
                cell: seed,
                elevation: elev
            });
            rightElevations.push(elev);
        }
    }

    leftElevations.sort((a, b) => a - b);
    rightElevations.sort((a, b) => a - b);

    // Calculate minimum seed elevation for upstream/downstream detection
    const minSeedElevation = Math.min(
        leftElevations[0] || Infinity,
        rightElevations[0] || Infinity
    );

    debugLog(`Left seeds: ${leftElevations.length} from ${leftElevations[0]?.toFixed(1)}m to ${leftElevations[leftElevations.length - 1]?.toFixed(1)}m`);
    debugLog(`Right seeds: ${rightElevations.length} from ${rightElevations[0]?.toFixed(1)}m to ${rightElevations[rightElevations.length - 1]?.toFixed(1)}m`);
    debugLog(`Starting physics-based flood from ${flooded.size} multi-elevation seeds`);

    let iterations = 0;
    let lastEdgeCheck = 0;
    const edgeCheckInterval = 50000;  // Check for edge proximity every N iterations
    const minIterationsBeforeCheck = 50000;  // Don't check until at least this many iterations

    while (queue.length > 0 && iterations < CONFIG.maxIterations) {
        iterations++;

        if (iterations % CONFIG.progressUpdateInterval === 0) {
            debugLog(`Iteration ${iterations}, queue: ${queue.length}, flooded: ${flooded.size}`);
            self.postMessage({ progress: 0.1 + (iterations / CONFIG.maxIterations) * 0.4 });
        }

        // Periodically check if flooding is approaching DEM edge
        if (iterations >= minIterationsBeforeCheck && iterations - lastEdgeCheck >= edgeCheckInterval) {
            lastEdgeCheck = iterations;
            const edgeInfo = isApproachingEdge(flooded, width, height);
            if (edgeInfo) {
                debugLog(`Flooding approaching DEM edge at ${flooded.size} cells - checking for confined bodies`);

                // Try to identify a confined upstream body before requesting expansion
                const confinedBody = checkForConfinedBody(flooded, visited, width, height, data, crestElevation, damCells, minSeedElevation);

                if (confinedBody) {
                    // Found a confined body - select it as upstream and finish
                    debugLog(`Confined body identified - stopping expansion and selecting upstream`);
                    return confinedBody;
                }

                // Couldn't identify confined body - request expansion
                debugLog(`No confined body found - requesting expansion`);
                self.postMessage({
                    needMoreDEM: true,
                    currentSize: flooded.size,
                    iterations: iterations,
                    edges: edgeInfo
                });
                return null;  // Return null to signal expansion (don't send completion message)
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
 * Find seed cells adjacent to dam at multiple elevations
 * Multi-elevation seeding helps escape local minima (downstream paths)
 * and find upstream valleys that may be topographically disconnected
 */
function findSeedCells(damCells, barriers, data, width, height, crestElevation) {
    const allPotentialSeeds = new Map(); // elevation -> [cells]
    const seenSeeds = new Set();

    // Collect all potential seed cells with their elevations
    for (let damCell of damCells) {
        const neighbors = getNeighbors(damCell, width, height);

        for (let neighbor of neighbors) {
            if (barriers.has(neighbor) || seenSeeds.has(neighbor)) continue;

            const elevation = data[neighbor];

            if (elevation > CONFIG.noDataValue && elevation < crestElevation) {
                seenSeeds.add(neighbor);

                // Round to 10m bands for grouping
                const elevBand = Math.floor(elevation / 10) * 10;
                if (!allPotentialSeeds.has(elevBand)) {
                    allPotentialSeeds.set(elevBand, []);
                }
                allPotentialSeeds.get(elevBand).push({ cell: neighbor, elevation });
            }
        }
    }

    // If no seeds found, search 2 cells away
    if (allPotentialSeeds.size === 0) {
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
                                seenSeeds.add(cell);

                                const elevBand = Math.floor(elevation / 10) * 10;
                                if (!allPotentialSeeds.has(elevBand)) {
                                    allPotentialSeeds.set(elevBand, []);
                                }
                                allPotentialSeeds.get(elevBand).push({ cell, elevation });
                            }
                        }
                    }
                }
            }
        }
    }

    // Select seeds from multiple elevation bands
    const seeds = [];
    const elevationBands = Array.from(allPotentialSeeds.keys()).sort((a, b) => a - b);

    // If we have many elevation bands, sample them
    // Take valley bottom, mid-elevations, and near-crest seeds
    const bandsToUse = [];
    if (elevationBands.length <= 5) {
        // Use all bands if we have few
        bandsToUse.push(...elevationBands);
    } else {
        // Sample bands: lowest, several mid-points, highest
        bandsToUse.push(elevationBands[0]); // Lowest (valley bottom)
        bandsToUse.push(elevationBands[Math.floor(elevationBands.length * 0.33)]);
        bandsToUse.push(elevationBands[Math.floor(elevationBands.length * 0.67)]);
        bandsToUse.push(elevationBands[elevationBands.length - 1]); // Highest
    }

    debugLog(`Found ${elevationBands.length} elevation bands, using ${bandsToUse.length} for multi-elevation seeding`);

    for (let band of bandsToUse) {
        const cellsInBand = allPotentialSeeds.get(band);
        // Add up to 5 seeds from each band
        for (let i = 0; i < Math.min(5, cellsInBand.length); i++) {
            seeds.push(cellsInBand[i].cell);
        }
        debugLog(`  Band ${band}m: ${cellsInBand.length} cells, using ${Math.min(5, cellsInBand.length)}`);
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
        const edgesTouched = { north: false, south: false, east: false, west: false };
        let minX = width, maxX = 0, minY = height, maxY = 0;

        while (queue.length > 0) {
            const cell = queue.shift();
            const x = cell % width;
            const y = Math.floor(cell / width);

            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;

            // Track which edges this body touches
            if (x === 0) { touchesEdge = true; edgesTouched.west = true; }
            if (x === width - 1) { touchesEdge = true; edgesTouched.east = true; }
            if (y === 0) { touchesEdge = true; edgesTouched.north = true; }
            if (y === height - 1) { touchesEdge = true; edgesTouched.south = true; }

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
            edgesTouched,
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
    const edges = { west: false, east: false, north: false, south: false };

    for (let cell of flooded) {
        const x = cell % width;
        const y = Math.floor(cell / width);

        if (x < threshold) edges.west = true;
        if (x >= width - threshold) edges.east = true;
        if (y < threshold) edges.north = true;
        if (y >= height - threshold) edges.south = true;
    }

    const approaching = edges.west || edges.east || edges.north || edges.south;

    if (approaching) {
        const directions = [];
        if (edges.north) directions.push('north');
        if (edges.south) directions.push('south');
        if (edges.east) directions.push('east');
        if (edges.west) directions.push('west');
        debugLog(`Approaching edges: ${directions.join(', ')}`);
    }

    return approaching ? edges : null;
}

/**
 * Check if we can identify a confined (upstream) water body without expansion
 * Returns the upstream body if found, null if expansion is needed
 */
function checkForConfinedBody(flooded, visited, width, height, data, crestElevation, damCells, minSeedElevation) {
    // Run connected component analysis
    const bodies = identifyWaterBodies(flooded, visited, width, height, data, crestElevation);

    if (bodies.length < 2) {
        // Only one body, can't determine yet - need expansion
        return null;
    }

    debugLog(`Checking ${bodies.length} water bodies for confinement`);

    // Minimum size for a valid reservoir (ignore tiny artifacts like trapped seed cells)
    const MIN_RESERVOIR_SIZE = 10;

    // Check if any body is NOT touching edges (fully confined) and large enough to be real
    const confinedBodies = bodies.filter(body => !body.touchesEdge && body.size >= MIN_RESERVOIR_SIZE);

    if (confinedBodies.length === 1) {
        const body = confinedBodies[0];
        const fillLevel = body.maxElevation;
        const fillDeficit = crestElevation - fillLevel;

        debugLog(`Found confined body ${body.id} (${body.size} cells), maxElev=${fillLevel.toFixed(1)}m, crest=${crestElevation.toFixed(1)}m, deficit=${fillDeficit.toFixed(1)}m`);

        // Check if this is a downstream body (minElev significantly below seed elevations)
        // Downstream bodies flow away from dam at much lower elevations
        const elevationDrop = minSeedElevation - body.minElevation;
        if (elevationDrop > 100) {
            debugLog(`Confined body is downstream (${elevationDrop.toFixed(1)}m below seed elevation) - rejecting`);
            return null;  // This is downstream, need expansion to find upstream
        }

        // A fully confined body (not touching any edges) at appropriate elevation IS the upstream reservoir
        // Accept it immediately regardless of fill level - the deficit just means
        // the upstream valley doesn't reach the dam crest elevation
        debugLog(`Confined body selected as upstream (fully enclosed, appropriate elevation)`);
        return body.cells;
    }

    // If all bodies touch edges, analyze which is likely upstream
    // Upstream characteristics:
    // - Smaller size (confined valley vs downstream spread)
    // - Higher minimum elevation (valley floor)
    // - NOT touching south/west edges (downstream direction for most Alps locations)

    let upstreamCandidate = null;
    let bestScore = -Infinity;

    // Only consider bodies large enough to be real reservoirs
    const validBodies = bodies.filter(body => body.size >= MIN_RESERVOIR_SIZE);

    for (let body of validBodies) {
        let score = 0;

        // Prefer smaller bodies (confined)
        score -= body.size / 10000;

        // Prefer higher minimum elevation (valley floor)
        score += body.minElevation / 10;

        // Strongly penalize bodies touching south or west edges (likely downstream)
        if (body.edgesTouched.south) score -= 500;
        if (body.edgesTouched.west) score -= 500;

        // Slightly prefer bodies touching north or east (upstream for most valleys)
        if (body.edgesTouched.north) score += 50;
        if (body.edgesTouched.east) score += 50;

        debugLog(`Body ${body.id}: size=${body.size}, minElev=${body.minElevation.toFixed(1)}m, edges=${JSON.stringify(body.edgesTouched)}, score=${score.toFixed(1)}`);

        if (score > bestScore) {
            bestScore = score;
            upstreamCandidate = body;
        }
    }

    // If we have a clear winner (not touching south/west), accept it with relaxed fill criteria
    if (upstreamCandidate && !upstreamCandidate.edgesTouched.south && !upstreamCandidate.edgesTouched.west) {
        const fillLevel = upstreamCandidate.maxElevation;
        const fillDeficit = crestElevation - fillLevel;

        debugLog(`Upstream candidate body ${upstreamCandidate.id} (score=${bestScore.toFixed(1)}), maxElev=${fillLevel.toFixed(1)}m, deficit=${fillDeficit.toFixed(1)}m`);

        // Check if this is a downstream body (minElev significantly below seed elevations)
        const elevationDrop = minSeedElevation - upstreamCandidate.minElevation;
        if (elevationDrop > 100) {
            debugLog(`Upstream candidate is downstream (${elevationDrop.toFixed(1)}m below seed elevation) - rejecting`);
            return null;  // This is downstream, need expansion to find upstream
        }

        // Accept upstream candidates with large deficits - the valley may not reach dam elevation
        // Only reject if deficit is extreme (>200m), which suggests we haven't found the real valley yet
        if (fillDeficit > 200) {
            debugLog(`Upstream candidate deficit too large (${fillDeficit.toFixed(1)}m) - continuing flood`);
            return null;  // Let flooding continue
        }

        debugLog(`Selected body ${upstreamCandidate.id} as upstream`);
        return upstreamCandidate.cells;
    }

    // Can't confidently determine - need expansion
    return null;
}
