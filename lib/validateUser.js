/**
 * User & Profile Validation Module
 * 
 * Validates user and profile documents against the canonical schema.
 * Use this in backend routes to enforce consistent data structure.
 * 
 * Usage:
 *   import { validateUserDoc, validateProfileDoc, validateUserUpdate } from '../lib/validateUser.js';
 *   
 *   // In auth routes:
 *   const errors = validateUserDoc(newUserData);
 *   if (errors.length > 0) return res.status(400).json({ errors });
 * 
 *   // In user update routes:
 *   const errors = validateUserUpdate(updateData);
 *   if (errors.length > 0) return res.status(400).json({ errors });
 */

// ============ SCHEMA CONSTANTS ============

const USER_REQUIRED_FIELDS = {
  uid: 'string',
  email: 'string',
  role: 'string',
  createdAt: 'timestamp',
};

const USER_OPTIONAL_FIELDS = {
  disabled: 'boolean',
  updatedAt: 'timestamp',
};

const USER_FORBIDDEN_FIELDS = [
  'isAdmin', 'avatarUrl', 'name', 'bio', 'major', 'year', 'interests', 'createdBy',
];

const PROFILE_REQUIRED_FIELDS = {
  name: 'string',
};

const PROFILE_OPTIONAL_FIELDS = {
  major: 'string',
  year: 'number',
  bio: 'string',
  interests: 'array',
  avatarUrl: 'string',
  locationEnabled: 'boolean',
  locationLat: 'number',
  locationLng: 'number',
  locationUpdatedAt: 'timestamp',
  createdAt: 'timestamp',
  updatedAt: 'timestamp',
};

const PROFILE_FORBIDDEN_FIELDS = [
  'uid', 'email', 'role', 'disabled', 'isAdmin',
];

const VALID_ROLES = ['user', 'admin'];

// ============ UTILITY FUNCTIONS ============

/**
 * Check if value is a Firestore Timestamp
 */
const isTimestamp = (value) => {
  return value && typeof value === 'object' && '_seconds' in value && '_nanoseconds' in value;
};

/**
 * Check if value is a valid type
 */
const isValidType = (value, expectedType) => {
  switch (expectedType) {
    case 'string':
      return typeof value === 'string' && value.length > 0;
    case 'number':
      return typeof value === 'number' && !isNaN(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'array':
      return Array.isArray(value);
    case 'timestamp':
      return isTimestamp(value);
    default:
      return true;
  }
};

// ============ VALIDATION FUNCTIONS ============

/**
 * Validate a complete users/{uid} document
 * @param {Object} userDoc - User document to validate
 * @returns {Array<string>} - Array of error messages (empty = valid)
 */
export const validateUserDoc = (userDoc) => {
  const errors = [];

  if (!userDoc || typeof userDoc !== 'object') {
    return ['User doc must be an object'];
  }

  // Check required fields
  Object.entries(USER_REQUIRED_FIELDS).forEach(([field, type]) => {
    if (!(field in userDoc)) {
      errors.push(`Missing required field: ${field}`);
    } else if (!isValidType(userDoc[field], type)) {
      errors.push(`Field "${field}" must be ${type}, got ${typeof userDoc[field]}`);
    }
  });

  // Check field types (optional fields if present)
  Object.entries(USER_OPTIONAL_FIELDS).forEach(([field, type]) => {
    if (field in userDoc && userDoc[field] !== null && !isValidType(userDoc[field], type)) {
      errors.push(`Field "${field}" must be ${type}, got ${typeof userDoc[field]}`);
    }
  });

  // Check for forbidden fields
  USER_FORBIDDEN_FIELDS.forEach((field) => {
    if (field in userDoc) {
      errors.push(`Forbidden field: ${field} (should be in profiles, not users)`);
    }
  });

  // Validate role enum
  if ('role' in userDoc && !VALID_ROLES.includes(userDoc.role)) {
    errors.push(`Invalid role "${userDoc.role}". Must be one of: ${VALID_ROLES.join(', ')}`);
  }

  // Validate email format
  if ('email' in userDoc) {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(userDoc.email)) {
      errors.push(`Invalid email format: ${userDoc.email}`);
    }
  }

  return errors;
};

/**
 * Validate a complete profiles/{uid} document
 * @param {Object} profileDoc - Profile document to validate
 * @returns {Array<string>} - Array of error messages (empty = valid)
 */
export const validateProfileDoc = (profileDoc) => {
  const errors = [];

  if (!profileDoc || typeof profileDoc !== 'object') {
    return ['Profile doc must be an object'];
  }

  // Check required fields
  Object.entries(PROFILE_REQUIRED_FIELDS).forEach(([field, type]) => {
    if (!(field in profileDoc)) {
      errors.push(`Missing required field: ${field}`);
    } else if (!isValidType(profileDoc[field], type)) {
      errors.push(`Field "${field}" must be ${type}, got ${typeof profileDoc[field]}`);
    }
  });

  // Check optional field types
  Object.entries(PROFILE_OPTIONAL_FIELDS).forEach(([field, type]) => {
    if (field in profileDoc && profileDoc[field] !== null && !isValidType(profileDoc[field], type)) {
      errors.push(`Field "${field}" must be ${type}, got ${typeof profileDoc[field]}`);
    }
  });

  // Check for forbidden fields
  PROFILE_FORBIDDEN_FIELDS.forEach((field) => {
    if (field in profileDoc) {
      errors.push(`Forbidden field: ${field} (should be in users, not profiles)`);
    }
  });

  // Validate year (if present)
  if ('year' in profileDoc && profileDoc.year !== null) {
    if (!Number.isInteger(profileDoc.year) || profileDoc.year < 1 || profileDoc.year > 10) {
      errors.push(`Field "year" must be an integer between 1 and 10, got ${profileDoc.year}`);
    }
  }

  // Validate location coordinates (if present)
  if ('locationLat' in profileDoc && profileDoc.locationLat !== null) {
    const lat = profileDoc.locationLat;
    if (typeof lat !== 'number' || lat < -90 || lat > 90) {
      errors.push(`Field "locationLat" must be between -90 and 90, got ${lat}`);
    }
  }

  if ('locationLng' in profileDoc && profileDoc.locationLng !== null) {
    const lng = profileDoc.locationLng;
    if (typeof lng !== 'number' || lng < -180 || lng > 180) {
      errors.push(`Field "locationLng" must be between -180 and 180, got ${lng}`);
    }
  }

  // Validate interests array
  if ('interests' in profileDoc && Array.isArray(profileDoc.interests)) {
    const invalidInterests = profileDoc.interests.filter(i => typeof i !== 'string' || i.length === 0);
    if (invalidInterests.length > 0) {
      errors.push(`Field "interests" must contain only non-empty strings`);
    }
  }

  return errors;
};

/**
 * Validate a partial user update (subset of fields)
 * Use this when users are updating their own documents
 * 
 * @param {Object} updateData - Fields being updated
 * @param {boolean} isAdmin - Whether the requester is admin (affects what can be changed)
 * @returns {Array<string>} - Array of error messages
 */
export const validateUserUpdate = (updateData, isAdmin = false) => {
  const errors = [];

  if (!updateData || typeof updateData !== 'object') {
    return ['Update data must be an object'];
  }

  // Only admins can update these fields
  const adminOnlyFields = ['role', 'disabled', 'email'];
  if (!isAdmin) {
    adminOnlyFields.forEach((field) => {
      if (field in updateData) {
        errors.push(`Only admins can update field: ${field}`);
      }
    });
  }

  // Forbidden fields should never be in user updates
  USER_FORBIDDEN_FIELDS.forEach((field) => {
    if (field in updateData) {
      errors.push(`Cannot update forbidden field: ${field}`);
    }
  });

  // Validate types for fields being updated
  if ('role' in updateData && !VALID_ROLES.includes(updateData.role)) {
    errors.push(`Invalid role "${updateData.role}". Must be one of: ${VALID_ROLES.join(', ')}`);
  }

  if ('disabled' in updateData && typeof updateData.disabled !== 'boolean') {
    errors.push(`Field "disabled" must be boolean, got ${typeof updateData.disabled}`);
  }

  if ('email' in updateData) {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(updateData.email)) {
      errors.push(`Invalid email format: ${updateData.email}`);
    }
  }

  return errors;
};

/**
 * Validate a partial profile update
 * Use this when users are updating their profile
 * 
 * @param {Object} updateData - Fields being updated
 * @returns {Array<string>} - Array of error messages
 */
export const validateProfileUpdate = (updateData) => {
  const errors = [];

  if (!updateData || typeof updateData !== 'object') {
    return ['Update data must be an object'];
  }

  // Forbidden fields should never be in profile updates
  PROFILE_FORBIDDEN_FIELDS.forEach((field) => {
    if (field in updateData) {
      errors.push(`Cannot update forbidden field: ${field}`);
    }
  });

  // Validate types for fields being updated
  Object.entries(PROFILE_OPTIONAL_FIELDS).forEach(([field, type]) => {
    if (field in updateData && updateData[field] !== null) {
      if (!isValidType(updateData[field], type)) {
        errors.push(`Field "${field}" must be ${type}, got ${typeof updateData[field]}`);
      }
    }
  });

  // Special validation for name (only allow updates from profile routes)
  if ('name' in updateData && typeof updateData.name !== 'string') {
    errors.push(`Field "name" must be string, got ${typeof updateData.name}`);
  }

  // Validate year
  if ('year' in updateData && updateData.year !== null) {
    if (!Number.isInteger(updateData.year) || updateData.year < 1 || updateData.year > 10) {
      errors.push(`Field "year" must be an integer between 1 and 10, got ${updateData.year}`);
    }
  }

  // Validate location coordinates
  if ('locationLat' in updateData && updateData.locationLat !== null) {
    const lat = updateData.locationLat;
    if (typeof lat !== 'number' || lat < -90 || lat > 90) {
      errors.push(`Field "locationLat" must be between -90 and 90, got ${lat}`);
    }
  }

  if ('locationLng' in updateData && updateData.locationLng !== null) {
    const lng = updateData.locationLng;
    if (typeof lng !== 'number' || lng < -180 || lng > 180) {
      errors.push(`Field "locationLng" must be between -180 and 180, got ${lng}`);
    }
  }

  // Validate interests
  if ('interests' in updateData && Array.isArray(updateData.interests)) {
    const invalidInterests = updateData.interests.filter(i => typeof i !== 'string' || i.length === 0);
    if (invalidInterests.length > 0) {
      errors.push(`Field "interests" must contain only non-empty strings`);
    }
    if (updateData.interests.length > 50) {
      errors.push(`Field "interests" cannot have more than 50 items`);
    }
  }

  // Validate bio length
  if ('bio' in updateData && typeof updateData.bio === 'string') {
    if (updateData.bio.length > 500) {
      errors.push(`Field "bio" cannot exceed 500 characters`);
    }
  }

  return errors;
};

/**
 * Create a clean user document from raw data
 * Strips forbidden fields and sets defaults for missing optional fields
 * 
 * @param {Object} rawData - User data (potentially from external source)
 * @returns {Object} - Cleaned user document
 */
export const cleanUserDoc = (rawData) => {
  const cleaned = {};

  // Copy allowed fields
  ['uid', 'email', 'role', 'createdAt', 'disabled', 'updatedAt'].forEach((field) => {
    if (field in rawData) {
      cleaned[field] = rawData[field];
    }
  });

  // Set defaults for missing required fields
  if (!cleaned.role) cleaned.role = 'user';
  if (!cleaned.disabled) cleaned.disabled = false;

  return cleaned;
};

/**
 * Create a clean profile document from raw data
 * Strips forbidden fields and sets defaults for missing optional fields
 * 
 * @param {Object} rawData - Profile data
 * @returns {Object} - Cleaned profile document
 */
export const cleanProfileDoc = (rawData) => {
  const cleaned = {};

  // Copy allowed fields
  const allowedFields = Object.keys(PROFILE_REQUIRED_FIELDS)
    .concat(Object.keys(PROFILE_OPTIONAL_FIELDS));

  allowedFields.forEach((field) => {
    if (field in rawData) {
      cleaned[field] = rawData[field];
    }
  });

  // Set defaults for missing optional fields
  if (!cleaned.interests) cleaned.interests = [];
  if (!cleaned.major) cleaned.major = '';
  if (!cleaned.bio) cleaned.bio = '';
  if (!cleaned.avatarUrl) cleaned.avatarUrl = '';
  if (typeof cleaned.locationEnabled !== 'boolean') cleaned.locationEnabled = false;

  return cleaned;
};

// ============ EXPORTS ============

export default {
  validateUserDoc,
  validateProfileDoc,
  validateUserUpdate,
  validateProfileUpdate,
  cleanUserDoc,
  cleanProfileDoc,
};
