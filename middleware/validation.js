/**
 * Request validation middleware
 */

/**
 * Validate request parameters
 * @param {Object} schema - Validation schema
 * @returns {Function} - Express middleware
 */
export const validateParams = (schema) => {
  return (req, res, next) => {
    const errors = [];

    for (const [key, rules] of Object.entries(schema)) {
      const value = req.params[key];

      if (rules.required && (value === undefined || value === null || value === '')) {
        errors.push(`Parameter '${key}' is required`);
        continue;
      }

      if (value !== undefined && value !== null && value !== '') {
        if (rules.type && typeof value !== rules.type) {
          errors.push(`Parameter '${key}' must be of type ${rules.type}`);
        }

        if (rules.validator) {
          const result = rules.validator(value);
          if (result !== true) {
            errors.push(result || `Parameter '${key}' is invalid`);
          }
        }
      }
    }

    if (errors.length > 0) {
      return res.status(400).json({
        success: false,
        error: 'Validation failed',
        details: errors,
      });
    }

    next();
  };
};

/**
 * Validate request query parameters
 * @param {Object} schema - Validation schema
 * @returns {Function} - Express middleware
 */
export const validateQuery = (schema) => {
  return (req, res, next) => {
    const errors = [];

    for (const [key, rules] of Object.entries(schema)) {
      const value = req.query[key];

      if (rules.required && (value === undefined || value === null || value === '')) {
        errors.push(`Query parameter '${key}' is required`);
        continue;
      }

      if (value !== undefined && value !== null && value !== '') {
        // Type conversion for numbers
        if (rules.type === 'number') {
          const numValue = Number(value);
          if (isNaN(numValue)) {
            errors.push(`Query parameter '${key}' must be a number`);
            continue;
          }
          if (rules.min !== undefined && numValue < rules.min) {
            errors.push(`Query parameter '${key}' must be at least ${rules.min}`);
          }
          if (rules.max !== undefined && numValue > rules.max) {
            errors.push(`Query parameter '${key}' must be at most ${rules.max}`);
          }
        }

        if (rules.type === 'string') {
          if (typeof value !== 'string') {
            errors.push(`Query parameter '${key}' must be a string`);
            continue;
          }
          if (rules.minLength !== undefined && value.length < rules.minLength) {
            errors.push(`Query parameter '${key}' must be at least ${rules.minLength} characters`);
          }
          if (rules.maxLength !== undefined && value.length > rules.maxLength) {
            errors.push(`Query parameter '${key}' must be at most ${rules.maxLength} characters`);
          }
          if (rules.pattern && !rules.pattern.test(value)) {
            errors.push(`Query parameter '${key}' format is invalid`);
          }
        }

        if (rules.validator) {
          const result = rules.validator(value);
          if (result !== true) {
            errors.push(result || `Query parameter '${key}' is invalid`);
          }
        }
      }
    }

    if (errors.length > 0) {
      return res.status(400).json({
        success: false,
        error: 'Validation failed',
        details: errors,
      });
    }

    next();
  };
};

/**
 * Validate request body
 * @param {Object} schema - Validation schema
 * @returns {Function} - Express middleware
 */
export const validateBody = (schema) => {
  return (req, res, next) => {
    const errors = [];

    for (const [key, rules] of Object.entries(schema)) {
      const value = req.body[key];

      if (rules.required && (value === undefined || value === null || value === '')) {
        errors.push(`Field '${key}' is required`);
        continue;
      }

      if (value !== undefined && value !== null && value !== '') {
        if (rules.type && typeof value !== rules.type) {
          // Special handling for arrays
          if (rules.type === 'array' && !Array.isArray(value)) {
            errors.push(`Field '${key}' must be an array`);
            continue;
          }
          if (rules.type !== 'array' && typeof value !== rules.type) {
            errors.push(`Field '${key}' must be of type ${rules.type}`);
            continue;
          }
        }

        if (rules.type === 'string') {
          if (rules.minLength !== undefined && value.length < rules.minLength) {
            errors.push(`Field '${key}' must be at least ${rules.minLength} characters`);
          }
          if (rules.maxLength !== undefined && value.length > rules.maxLength) {
            errors.push(`Field '${key}' must be at most ${rules.maxLength} characters`);
          }
          if (rules.pattern && !rules.pattern.test(value)) {
            errors.push(`Field '${key}' format is invalid`);
          }
        }

        if (rules.type === 'number') {
          if (rules.min !== undefined && value < rules.min) {
            errors.push(`Field '${key}' must be at least ${rules.min}`);
          }
          if (rules.max !== undefined && value > rules.max) {
            errors.push(`Field '${key}' must be at most ${rules.max}`);
          }
        }

        if (rules.type === 'array') {
          if (rules.maxItems !== undefined && value.length > rules.maxItems) {
            errors.push(`Field '${key}' must have at most ${rules.maxItems} items`);
          }
        }

        if (rules.validator) {
          const result = rules.validator(value);
          if (result !== true) {
            errors.push(result || `Field '${key}' is invalid`);
          }
        }
      }
    }

    if (errors.length > 0) {
      return res.status(400).json({
        success: false,
        error: errors.length === 1 ? errors[0] : 'Validation failed',
        message: errors.length === 1 ? errors[0] : 'Validation failed',
        details: errors,
      });
    }

    next();
  };
};
