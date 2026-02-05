/**
 * Error handling middleware utilities
 */

/**
 * Wraps async route handlers to catch errors
 * @param {Function} fn - Async route handler
 * @returns {Function} - Express middleware
 */
export const asyncHandler = (fn) => {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
};

/**
 * Send success response
 * @param {Object} res - Express response object
 * @param {*} data - Response data
 * @param {number} statusCode - HTTP status code (default: 200)
 */
export const sendSuccess = (res, data, statusCode = 200) => {
  return res.status(statusCode).json({
    success: true,
    ...(typeof data === 'object' && !Array.isArray(data) ? data : { data }),
  });
};

/**
 * Send error response
 * @param {Object} res - Express response object
 * @param {number} statusCode - HTTP status code
 * @param {string} message - Error message
 * @param {*} details - Additional error details
 */
export const sendError = (res, statusCode, message, details = null) => {
  return res.status(statusCode).json({
    success: false,
    error: message,
    ...(details && { details }),
  });
};
