/**
 * Performance Timer Utility
 * Provides simple timing instrumentation for performance monitoring
 */

export class PerformanceTimer {
    static timings = new Map();

    /**
     * Start a named timer
     * @param {string} label - Timer label
     */
    static start(label) {
        this.timings.set(label, performance.now());
    }

    /**
     * End a named timer and log the duration
     * @param {string} label - Timer label
     * @returns {number|null} Duration in milliseconds, or null if timer wasn't started
     */
    static end(label) {
        const start = this.timings.get(label);
        if (start !== undefined) {
            const duration = performance.now() - start;
            console.log(`⏱️  ${label}: ${duration.toFixed(2)}ms`);
            this.timings.delete(label);
            return duration;
        }
        console.warn(`Timer "${label}" was not started`);
        return null;
    }

    /**
     * Get elapsed time without ending the timer
     * @param {string} label - Timer label
     * @returns {number|null} Duration in milliseconds, or null if timer wasn't started
     */
    static elapsed(label) {
        const start = this.timings.get(label);
        if (start !== undefined) {
            return performance.now() - start;
        }
        return null;
    }

    /**
     * Clear a specific timer without logging
     * @param {string} label - Timer label
     */
    static clear(label) {
        this.timings.delete(label);
    }

    /**
     * Clear all timers
     */
    static clearAll() {
        this.timings.clear();
    }

    /**
     * Execute a function and measure its execution time
     * @param {string} label - Timer label
     * @param {Function} fn - Function to execute
     * @returns {Promise<any>} Result of the function
     */
    static async measure(label, fn) {
        this.start(label);
        try {
            return await fn();
        } finally {
            this.end(label);
        }
    }
}
