/**
 * Retry Utility
 * Retries an async function with exponential backoff
 */

/**
 * @param {Function} fn - Async function to retry
 * @param {number} maxRetries - Maximum number of retry attempts
 * @param {number} baseDelay - Base delay in milliseconds (doubles each attempt)
 * @returns {Promise} Result of the function
 */
export async function retryWithBackoff(fn, maxRetries = 2, baseDelay = 500) {
    let lastError;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            return await fn();
        } catch (error) {
            lastError = error;
            if (attempt < maxRetries) {
                await new Promise(resolve => setTimeout(resolve, baseDelay * Math.pow(2, attempt)));
            }
        }
    }
    throw new Error(`Failed after ${maxRetries + 1} attempts: ${lastError.message}`, { cause: lastError });
}
