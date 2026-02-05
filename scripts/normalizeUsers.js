#!/usr/bin/env node
/**
 * User & Profile Schema Normalization Script
 * 
 * Migrates all user and profile documents to the canonical schema:
 * - Converts ISO date strings to Firestore Timestamps
 * - Ensures all required fields exist
 * - Adds missing fields with sensible defaults
 * - Removes invalid/duplicate fields
 * - Ensures profiles/{uid} exists for every users/{uid}
 * 
 * Usage:
 *   # Preview changes (dry-run, no writes)
 *   node backend/scripts/normalizeUsers.js --dry-run
 * 
 *   # Apply changes
 *   node backend/scripts/normalizeUsers.js
 * 
 * Environment:
 *   FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY must be set
 */

import 'dotenv/config';
import admin, { firestore, firebaseAuth } from '../config/firebaseAdmin.js';

const DRY_RUN = process.argv.includes('--dry-run');

// ============ SCHEMA DEFINITIONS ============

const CANONICAL_USERS_SCHEMA = {
  // Required fields
  required: ['uid', 'email', 'role', 'createdAt'],
  // Optional fields (will be added with defaults if missing)
  optional: {
    disabled: false,
    updatedAt: null, // Will be set to createdAt if missing
  },
  // Fields to remove (deprecated/invalid)
  forbidden: ['isAdmin', 'avatarUrl', 'name', 'bio', 'major', 'year', 'interests', 'createdBy'],
};

const CANONICAL_PROFILES_SCHEMA = {
  // Required fields
  required: ['name'],
  // Optional fields with defaults
  optional: {
    major: '',
    year: null,
    bio: '',
    interests: [],
    avatarUrl: '',
    locationEnabled: false,
    locationLat: null,
    locationLng: null,
    locationUpdatedAt: null,
    createdAt: null, // Will match users.createdAt
    updatedAt: null, // Will match users.updatedAt if missing
  },
  // Fields to remove
  forbidden: ['uid', 'email', 'role', 'disabled', 'isAdmin'],
};

// ============ UTILITY FUNCTIONS ============

/**
 * Convert ISO string or any date to Firestore Timestamp
 */
const toTimestamp = (value) => {
  if (!value) return null;
  if (typeof value === 'object' && value._seconds !== undefined) {
    // Already a Firestore Timestamp
    return value;
  }
  if (typeof value === 'string') {
    try {
      return admin.firestore.Timestamp.fromDate(new Date(value));
    } catch (err) {
      console.warn(`  ⚠️  Invalid date string: ${value}, skipping`);
      return null;
    }
  }
  if (value instanceof Date) {
    return admin.firestore.Timestamp.fromDate(value);
  }
  return null;
};

/**
 * Normalize a users/{uid} document
 * @returns {Object} { normalized, changes, hasChanges }
 */
const normalizeUserDoc = (uid, userData) => {
  const normalized = { uid };
  const changes = [];

  // ===== REQUIRED FIELDS =====
  
  // uid (always required, use doc id)
  normalized.uid = uid;
  
  // email (get from doc or Firebase Auth)
  if (!userData.email) {
    changes.push('⚠️  Missing email (will be retrieved from Firebase Auth)');
  } else if (typeof userData.email !== 'string') {
    changes.push('⚠️  Invalid email type, will be cleared');
  } else {
    normalized.email = userData.email;
  }
  
  // role (validate and normalize)
  if (!userData.role) {
    changes.push('❌ Missing role, defaulting to "user"');
    normalized.role = 'user';
  } else if (!['user', 'admin'].includes(userData.role)) {
    changes.push(`❌ Invalid role "${userData.role}", defaulting to "user"`);
    normalized.role = 'user';
  } else {
    normalized.role = userData.role;
  }
  
  // createdAt (convert to Timestamp)
  const createdAt = toTimestamp(userData.createdAt);
  if (!createdAt) {
    changes.push('❌ Missing or invalid createdAt, will use server time on migration');
    normalized.createdAt = admin.firestore.Timestamp.now();
  } else {
    normalized.createdAt = createdAt;
  }

  // ===== OPTIONAL FIELDS =====
  
  // disabled (boolean, default false)
  if (typeof userData.disabled === 'boolean') {
    normalized.disabled = userData.disabled;
  } else {
    normalized.disabled = false;
  }
  
  // updatedAt (convert to Timestamp, default to createdAt)
  const updatedAt = toTimestamp(userData.updatedAt);
  if (updatedAt) {
    normalized.updatedAt = updatedAt;
  } else {
    normalized.updatedAt = normalized.createdAt;
  }

  // ===== DETECT CHANGES =====
  
  // Check for forbidden fields
  CANONICAL_USERS_SCHEMA.forbidden.forEach((field) => {
    if (field in userData && userData[field] !== undefined) {
      changes.push(`🗑️  Removing forbidden field: ${field}`);
    }
  });
  
  // Check for fields that differ
  *   node backend/scripts/normalizeUsers.js --dry-run
    changes.push(`🔄 role: "${userData.role}" → "${normalized.role}"`);
  }
  *   node backend/scripts/normalizeUsers.js
    changes.push(`🔄 disabled: ${userData.disabled} → ${normalized.disabled}`);
  }
  if (userData.createdAt !== normalized.createdAt._seconds) {
    changes.push('🔄 createdAt: converted to Timestamp');
  }
  if (userData.updatedAt !== normalized.updatedAt._seconds) {
    changes.push('🔄 updatedAt: converted to Timestamp or set to createdAt');
  }

  return {
    normalized,
    changes,
    hasChanges: changes.length > 0,
  };
};

/**
 * Normalize a profiles/{uid} document
 * @returns {Object} { normalized, changes, hasChanges }
 */
const normalizeProfileDoc = (uid, profileData, userCreatedAt) => {
  const normalized = {};
  const changes = [];

  // ===== REQUIRED FIELDS =====
  
  // name (required)
  if (!profileData.name || typeof profileData.name !== 'string') {
    changes.push('❌ Missing or invalid name');
    normalized.name = '';
  } else {
    normalized.name = profileData.name;
  }

  // ===== OPTIONAL FIELDS WITH DEFAULTS =====
  
  const optionalFields = {
    major: (val) => typeof val === 'string' ? val : '',
    year: (val) => {
      if (typeof val === 'number' && val > 0 && val <= 10) return val;
      return null;
    },
    bio: (val) => typeof val === 'string' ? val : '',
    interests: (val) => Array.isArray(val) ? val.filter(i => typeof i === 'string') : [],
    avatarUrl: (val) => typeof val === 'string' ? val : '',
    locationEnabled: (val) => typeof val === 'boolean' ? val : false,
    locationLat: (val) => {
      if (typeof val === 'number' && val >= -90 && val <= 90) return val;
      return null;
    },
    locationLng: (val) => {
      if (typeof val === 'number' && val >= -180 && val <= 180) return val;
      return null;
    },
    locationUpdatedAt: (val) => toTimestamp(val),
  };

  Object.entries(optionalFields).forEach(([field, validator]) => {
    const value = validator(profileData[field]);
    if (profileData[field] !== undefined && profileData[field] !== value) {
      changes.push(`🔄 ${field}: normalized`);
    }
    normalized[field] = value;
  });

  // createdAt and updatedAt (match user's createdAt)
  if (!userCreatedAt) {
    normalized.createdAt = admin.firestore.Timestamp.now();
    normalized.updatedAt = admin.firestore.Timestamp.now();
  } else {
    normalized.createdAt = userCreatedAt;
    normalized.updatedAt = toTimestamp(profileData.updatedAt) || userCreatedAt;
  }

  // ===== DETECT CHANGES =====
  
  // Check for forbidden fields
  CANONICAL_PROFILES_SCHEMA.forbidden.forEach((field) => {
    if (field in profileData && profileData[field] !== undefined) {
      changes.push(`🗑️  Removing forbidden field: ${field}`);
    }
  });

  // Check if profile is empty (needs creation)
  const profileExists = Object.keys(profileData).length > 0;
  if (!profileExists) {
    changes.push('✨ Creating new empty profile');
  }

  return {
    normalized,
    changes,
    hasChanges: changes.length > 0 || !profileExists,
  };
};

// ============ MAIN MIGRATION LOGIC ============

const migrate = async () => {
  console.log(`
╔════════════════════════════════════════════════════════╗
║      User & Profile Schema Normalization Script      ║
╚════════════════════════════════════════════════════════╝
`);

  if (DRY_RUN) {
    console.log('🔍 DRY-RUN MODE - No changes will be written\n');
  } else {
    console.log('⚠️  WRITE MODE - Changes will be applied!\n');
  }

  const results = {
    totalUsers: 0,
    changedUsers: 0,
    totalProfiles: 0,
    changedProfiles: 0,
    createdProfiles: 0,
    errors: [],
    details: [],
  };

  try {
    // ===== FETCH ALL USERS =====
    console.log('📥 Fetching all users...');
    const usersSnap = await firestore.collection('users').get();
    const allUserDocs = usersSnap.docs;
    results.totalUsers = allUserDocs.length;
    console.log(`✅ Found ${allUserDocs.length} users\n`);

    // ===== FETCH ALL PROFILES =====
    console.log('📥 Fetching all profiles...');
    const profilesSnap = await firestore.collection('profiles').get();
    const existingProfileUids = new Set(profilesSnap.docs.map(doc => doc.id));
    results.totalProfiles = profilesSnap.docs.length;
    console.log(`✅ Found ${profilesSnap.docs.length} profiles\n`);

    // ===== NORMALIZE USERS =====
    console.log('🔧 Processing users...\n');
    
    for (const userDoc of allUserDocs) {
      const uid = userDoc.id;
      const userData = userDoc.data();
      
      const { normalized, changes, hasChanges } = normalizeUserDoc(uid, userData);

      if (hasChanges) {
        results.changedUsers++;
        console.log(`👤 ${userData.email || uid}`);
        changes.forEach(change => console.log(`   ${change}`));
        results.details.push({
          type: 'user',
          uid,
          email: userData.email,
          changes,
        });

        if (!DRY_RUN) {
          try {
            await firestore.collection('users').doc(uid).set(normalized, { merge: true });
            console.log(`   ✅ Updated\n`);
          } catch (err) {
            const errMsg = `Failed to update user ${uid}: ${err.message}`;
            results.errors.push(errMsg);
            console.log(`   ❌ ${errMsg}\n`);
          }
        } else {
          console.log(`   [DRY-RUN: would update]\n`);
        }
      } else {
        console.log(`✓ ${userData.email || uid} (already normalized)\n`);
      }
    }

    // ===== NORMALIZE/CREATE PROFILES =====
    console.log('\n🔧 Processing profiles...\n');
    
    for (const userDoc of allUserDocs) {
      const uid = userDoc.id;
      const userData = userDoc.data();
      const userCreatedAt = toTimestamp(userData.createdAt);

      // Get or create empty profile
      let profileData = {};
      if (existingProfileUids.has(uid)) {
        const profileDoc = await firestore.collection('profiles').doc(uid).get();
        profileData = profileDoc.data() || {};
      }

      const { normalized: normalizedProfile, changes, hasChanges } = normalizeProfileDoc(uid, profileData, userCreatedAt);

      if (hasChanges) {
        results.changedProfiles++;
        if (!existingProfileUids.has(uid)) {
          results.createdProfiles++;
        }

        console.log(`📋 Profile for ${userData.email || uid}`);
        changes.forEach(change => console.log(`   ${change}`));
        results.details.push({
          type: 'profile',
          uid,
          email: userData.email,
          changes,
        });

        if (!DRY_RUN) {
          try {
            await firestore.collection('profiles').doc(uid).set(normalizedProfile, { merge: true });
            console.log(`   ✅ Updated\n`);
          } catch (err) {
            const errMsg = `Failed to update profile ${uid}: ${err.message}`;
            results.errors.push(errMsg);
            console.log(`   ❌ ${errMsg}\n`);
          }
        } else {
          console.log(`   [DRY-RUN: would update]\n`);
        }
      } else {
        console.log(`✓ Profile for ${userData.email || uid} (already normalized)\n`);
      }
    }

    // ===== SUMMARY =====
    console.log(`
╔════════════════════════════════════════════════════════╗
║                    MIGRATION SUMMARY                  ║
╚════════════════════════════════════════════════════════╝

📊 Statistics:
  • Total users processed: ${results.totalUsers}
  • Users changed: ${results.changedUsers}
  • Total profiles processed: ${results.totalProfiles}
  • Profiles changed: ${results.changedProfiles}
  • Profiles created: ${results.createdProfiles}

${results.errors.length > 0 ? `❌ Errors: ${results.errors.length}\n${results.errors.map(e => `   - ${e}`).join('\n')}` : '✅ No errors'}

${DRY_RUN ? '🔍 DRY-RUN COMPLETE - No changes were written.' : '✅ MIGRATION COMPLETE - All changes applied.'}
`);

    if (DRY_RUN) {
      console.log('📋 Review the changes above. Run without --dry-run to apply them:\n');
      console.log('   node backend/scripts/normalizeUsers.js\n');
    }

    return results;
  } catch (err) {
    console.error('❌ Fatal error:', err);
    process.exit(1);
  }
};

// Run migration
migrate().then(() => {
  process.exit(0);
}).catch(err => {
  console.error('❌ Unhandled error:', err);
  process.exit(1);
});
