#!/usr/bin/env node
/**
 * CRITICAL: Admin/User Collection Separation Migration
 * 
 * This script performs a major architectural change:
 * - Moves all admin users from users/{uid} → admins/{uid}
 * - Deletes admin profiles (admins don't have profiles)
 * - Keeps regular users in users/{uid} with their profiles/{uid}
 * - Adds required tenantId field to all users
 * - Enforces separate schemas for admins vs users
 * 
 * Usage:
 *   # STEP 1: Preview changes (ALWAYS run first)
 *   node backend/scripts/migrateAdminUserSeparation.js --dry-run
 * 
 *   # STEP 2: Apply changes (after reviewing dry-run)
 *   node backend/scripts/migrateAdminUserSeparation.js
 * 
 *   # STEP 3: Rollback (if needed)
 *   node backend/scripts/migrateAdminUserSeparation.js --rollback
 * 
 * Environment:
 *   FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY must be set
 */

import 'dotenv/config';
import admin, { firestore, firebaseAuth } from '../config/firebaseAdmin.js';

const DRY_RUN = process.argv.includes('--dry-run');
const ROLLBACK = process.argv.includes('--rollback');

// ============ SCHEMA DEFINITIONS ============

const ADMIN_SCHEMA = {
  required: ['uid', 'email', 'name', 'createdAt'],
  optional: {
    updatedAt: null,
    disabled: false,
  },
  forbidden: ['role', 'isAdmin', 'tenantId', 'avatarUrl', 'bio', 'major', 'year', 'interests', 
              'locationEnabled', 'locationLat', 'locationLng', 'locationUpdatedAt'],
};

const USER_SCHEMA = {
  required: ['uid', 'email', 'tenantId', 'name', 'createdAt'],
  optional: {
    avatarUrl: '',
    updatedAt: null,
    disabled: false,
    role: 'user', // 'user' or 'staff' (never 'admin')
  },
  forbidden: ['isAdmin', 'bio', 'major', 'year', 'interests'],
};

const PROFILE_SCHEMA = {
  required: ['uid', 'displayName', 'degree', 'year'],
  optional: {
    bio: '',
    interests: [],
    locationEnabled: false,
    locationLat: null,
    locationLng: null,
    locationUpdatedAt: null,
    createdAt: null,
    updatedAt: null,
  },
  forbidden: ['email', 'tenantId', 'role', 'disabled', 'isAdmin', 'avatarUrl', 'name', 'major'],
};

// ============ UTILITY FUNCTIONS ============

/**
 * Convert ISO string or any date to Firestore Timestamp
 */
const toTimestamp = (value) => {
  if (!value) return null;
  if (typeof value === 'object' && value._seconds !== undefined) {
    return value;
  }
  if (typeof value === 'string') {
    try {
      return admin.firestore.Timestamp.fromDate(new Date(value));
    } catch (err) {
      return null;
    }
  }
  if (value instanceof Date) {
    return admin.firestore.Timestamp.fromDate(value);
  }
  return null;
};

/**
 * Extract tenantId from email domain
 * e.g., alice@uel.ac.uk → "uel"
 *       bob@university.edu → "university"
 */
const extractTenantId = (email) => {
  if (!email || typeof email !== 'string') return 'default';
  
  const match = email.match(/@([^.]+)/);
  if (!match) return 'default';
  
  const domain = match[1].toLowerCase();
  return domain;
};

/**
 * Determine if a user document represents an admin
 */
const isAdminDoc = (userData) => {
  return userData.role === 'admin' || userData.isAdmin === true;
};

/**
 * Normalize an admin document for the admins/{uid} collection
 */
const normalizeAdminDoc = (uid, userData) => {
  const normalized = { uid };
  const changes = [];

  // Required: uid
  normalized.uid = uid;

  // Required: email
  if (!userData.email) {
    changes.push('❌ Missing email (critical error)');
    return { normalized: null, changes, hasChanges: true, error: true };
  }
  normalized.email = userData.email;

  // Required: name
  if (userData.name) {
    normalized.name = userData.name;
  } else if (userData.displayName) {
    normalized.name = userData.displayName;
    changes.push('🔄 Using displayName as name');
  } else {
    // Extract from email
    normalized.name = userData.email.split('@')[0];
    changes.push('✨ Generated name from email');
  }

  // Required: createdAt
  const createdAt = toTimestamp(userData.createdAt);
  if (!createdAt) {
    normalized.createdAt = admin.firestore.Timestamp.now();
    changes.push('✨ Setting createdAt to now');
  } else {
    normalized.createdAt = createdAt;
    if (typeof userData.createdAt === 'string') {
      changes.push('🔄 Converted createdAt to Timestamp');
    }
  }

  // Optional: updatedAt
  const updatedAt = toTimestamp(userData.updatedAt);
  normalized.updatedAt = updatedAt || normalized.createdAt;
  if (!updatedAt) {
    changes.push('✨ Set updatedAt = createdAt');
  } else if (typeof userData.updatedAt === 'string') {
    changes.push('🔄 Converted updatedAt to Timestamp');
  }

  // Optional: disabled
  normalized.disabled = typeof userData.disabled === 'boolean' ? userData.disabled : false;
  if (userData.disabled === undefined) {
    changes.push('✨ Set disabled = false');
  }

  // Remove forbidden fields
  ADMIN_SCHEMA.forbidden.forEach(field => {
    if (userData[field] !== undefined) {
      changes.push(`🗑️  Removed forbidden field: ${field}`);
    }
  });

  return { normalized, changes, hasChanges: changes.length > 0, error: false };
};

/**
 * Normalize a user document for the users/{uid} collection
 */
const normalizeUserDoc = (uid, userData) => {
  const normalized = { uid };
  const changes = [];

  // Required: uid
  normalized.uid = uid;

  // Required: email
  if (!userData.email) {
    changes.push('❌ Missing email (critical error)');
    return { normalized: null, changes, hasChanges: true, error: true };
  }
  normalized.email = userData.email;

  // Required: tenantId
  if (userData.tenantId) {
    normalized.tenantId = userData.tenantId;
  } else {
    normalized.tenantId = extractTenantId(userData.email);
    changes.push(`✨ Generated tenantId: ${normalized.tenantId}`);
  }

  // Required: name
  if (userData.name) {
    normalized.name = userData.name;
  } else if (userData.displayName) {
    normalized.name = userData.displayName;
    changes.push('🔄 Using displayName as name');
  } else {
    // Extract from email
    normalized.name = userData.email.split('@')[0];
    changes.push('✨ Generated name from email');
  }

  // Required: createdAt
  const createdAt = toTimestamp(userData.createdAt);
  if (!createdAt) {
    normalized.createdAt = admin.firestore.Timestamp.now();
    changes.push('✨ Setting createdAt to now');
  } else {
    normalized.createdAt = createdAt;
    if (typeof userData.createdAt === 'string') {
      changes.push('🔄 Converted createdAt to Timestamp');
    }
  }

  // Optional: avatarUrl
  normalized.avatarUrl = userData.avatarUrl || '';
  if (!userData.avatarUrl) {
    changes.push('✨ Set avatarUrl = ""');
  }

  // Optional: updatedAt
  const updatedAt = toTimestamp(userData.updatedAt);
  normalized.updatedAt = updatedAt || normalized.createdAt;
  if (!updatedAt) {
    changes.push('✨ Set updatedAt = createdAt');
  } else if (typeof userData.updatedAt === 'string') {
    changes.push('🔄 Converted updatedAt to Timestamp');
  }

  // Optional: disabled
  normalized.disabled = typeof userData.disabled === 'boolean' ? userData.disabled : false;
  if (userData.disabled === undefined) {
    changes.push('✨ Set disabled = false');
  }

  // Optional: role (user or staff, never admin)
  if (userData.role && userData.role !== 'admin') {
    normalized.role = userData.role;
  } else {
    normalized.role = 'user';
    if (userData.role === 'admin') {
      changes.push('❌ Had role=admin (should not happen if filtering worked)');
    } else {
      changes.push('✨ Set role = "user"');
    }
  }

  // Remove forbidden fields
  USER_SCHEMA.forbidden.forEach(field => {
    if (userData[field] !== undefined) {
      changes.push(`🗑️  Removed forbidden field: ${field}`);
    }
  });

  return { normalized, changes, hasChanges: changes.length > 0, error: false };
};

/**
 * Normalize a profile document for the profiles/{uid} collection
 */
const normalizeProfileDoc = (uid, profileData, userName, userCreatedAt) => {
  const normalized = { uid };
  const changes = [];

  // Required: uid
  normalized.uid = uid;

  // Required: displayName
  if (profileData && profileData.name) {
    normalized.displayName = profileData.name;
  } else if (profileData && profileData.displayName) {
    normalized.displayName = profileData.displayName;
  } else if (userName) {
    normalized.displayName = userName;
    changes.push('✨ Using user.name as displayName');
  } else {
    changes.push('❌ Missing displayName (critical error)');
    return { normalized: null, changes, hasChanges: true, error: true };
  }

  // Required: degree
  if (profileData && profileData.degree) {
    normalized.degree = profileData.degree;
  } else if (profileData && profileData.major) {
    normalized.degree = profileData.major;
    changes.push('🔄 Using major as degree');
  } else {
    normalized.degree = 'Not specified';
    changes.push('✨ Set degree = "Not specified"');
  }

  // Required: year
  if (profileData && profileData.year) {
    normalized.year = String(profileData.year);
  } else {
    normalized.year = 'Not specified';
    changes.push('✨ Set year = "Not specified"');
  }

  // Optional: bio
  normalized.bio = (profileData && profileData.bio) || '';
  if (!profileData || !profileData.bio) {
    changes.push('✨ Set bio = ""');
  }

  // Optional: interests
  normalized.interests = (profileData && Array.isArray(profileData.interests)) ? profileData.interests : [];
  if (!profileData || !Array.isArray(profileData.interests)) {
    changes.push('✨ Set interests = []');
  }

  // Optional: location fields
  normalized.locationEnabled = (profileData && typeof profileData.locationEnabled === 'boolean') 
    ? profileData.locationEnabled : false;
  normalized.locationLat = (profileData && typeof profileData.locationLat === 'number') 
    ? profileData.locationLat : null;
  normalized.locationLng = (profileData && typeof profileData.locationLng === 'number') 
    ? profileData.locationLng : null;
  
  const locationUpdatedAt = profileData ? toTimestamp(profileData.locationUpdatedAt) : null;
  normalized.locationUpdatedAt = locationUpdatedAt;

  // Optional: timestamps
  const createdAt = (profileData ? toTimestamp(profileData.createdAt) : null) || userCreatedAt;
  normalized.createdAt = createdAt;
  if (!profileData || !profileData.createdAt) {
    changes.push('✨ Set createdAt from user doc');
  }

  const updatedAt = (profileData ? toTimestamp(profileData.updatedAt) : null) || createdAt;
  normalized.updatedAt = updatedAt;
  if (!profileData || !profileData.updatedAt) {
    changes.push('✨ Set updatedAt = createdAt');
  }

  // Remove forbidden fields
  PROFILE_SCHEMA.forbidden.forEach(field => {
    if (profileData && profileData[field] !== undefined) {
      changes.push(`🗑️  Removed forbidden field: ${field}`);
    }
  });

  return { normalized, changes, hasChanges: changes.length > 0, error: false };
};

// ============ MIGRATION FUNCTIONS ============

/**
 * Main migration function
 */
const migrate = async () => {
  console.log('\n╔════════════════════════════════════════════════════════╗');
  console.log('║   Admin/User Collection Separation Migration         ║');
  console.log('╚════════════════════════════════════════════════════════╝\n');

  if (DRY_RUN) {
    console.log('🔍 DRY-RUN MODE - No changes will be written\n');
  } else {
    console.log('⚠️  LIVE MODE - Changes will be written to database\n');
  }

  const results = {
    adminsFound: 0,
    adminsMigrated: 0,
    adminProfilesDeleted: 0,
    usersFound: 0,
    usersCleaned: 0,
    profilesFound: 0,
    profilesNormalized: 0,
    errors: [],
    details: [],
  };

  try {
    // Fetch all users
    console.log('📥 Fetching all users from users/ collection...');
    const usersSnapshot = await firestore.collection('users').get();
    const allUserDocs = usersSnapshot.docs;
    console.log(`✅ Found ${allUserDocs.length} users\n`);

    // Fetch all profiles
    console.log('📥 Fetching all profiles from profiles/ collection...');
    const profilesSnapshot = await firestore.collection('profiles').get();
    const allProfileDocs = profilesSnapshot.docs;
    const profilesMap = {};
    allProfileDocs.forEach(doc => {
      profilesMap[doc.id] = doc.data();
    });
    results.profilesFound = allProfileDocs.length;
    console.log(`✅ Found ${allProfileDocs.length} profiles\n`);

    // Separate admins from users
    const adminDocs = [];
    const userDocs = [];

    allUserDocs.forEach(doc => {
      const userData = doc.data();
      if (isAdminDoc(userData)) {
        adminDocs.push({ uid: doc.id, data: userData });
      } else {
        userDocs.push({ uid: doc.id, data: userData });
      }
    });

    results.adminsFound = adminDocs.length;
    results.usersFound = userDocs.length;

    console.log(`📊 Classification:`);
    console.log(`   • Admins found: ${adminDocs.length}`);
    console.log(`   • Regular users found: ${userDocs.length}\n`);

    // ===== PROCESS ADMINS =====
    if (adminDocs.length > 0) {
      console.log('🔧 Processing admins (migrate to admins/ collection)...\n');

      for (const { uid, data } of adminDocs) {
        const { normalized, changes, hasChanges, error } = normalizeAdminDoc(uid, data);

        if (error) {
          console.log(`❌ Admin ${data.email || uid}: SKIPPED (critical error)`);
          changes.forEach(change => console.log(`   ${change}`));
          results.errors.push({ type: 'admin', uid, email: data.email, changes });
          continue;
        }

        if (hasChanges || !DRY_RUN) {
          results.adminsMigrated++;
          console.log(`👤 Admin: ${data.email}`);
          changes.forEach(change => console.log(`   ${change}`));

          if (!DRY_RUN) {
            // Write to admins/{uid}
            await firestore.collection('admins').doc(uid).set(normalized);
            console.log(`   ✅ Migrated to admins/${uid}`);

            // Delete from users/{uid}
            await firestore.collection('users').doc(uid).delete();
            console.log(`   🗑️  Deleted from users/${uid}`);

            // Delete profile if exists
            if (profilesMap[uid]) {
              await firestore.collection('profiles').doc(uid).delete();
              results.adminProfilesDeleted++;
              console.log(`   🗑️  Deleted profile profiles/${uid}`);
            }
          } else {
            console.log(`   [DRY-RUN: would migrate to admins/${uid}]`);
            console.log(`   [DRY-RUN: would delete from users/${uid}]`);
            if (profilesMap[uid]) {
              console.log(`   [DRY-RUN: would delete profile profiles/${uid}]`);
              results.adminProfilesDeleted++;
            }
          }
          console.log('');

          results.details.push({
            type: 'admin-migrated',
            uid,
            email: data.email,
            changes,
          });
        }
      }
    }

    // ===== PROCESS USERS =====
    if (userDocs.length > 0) {
      console.log('🔧 Processing regular users (clean in users/ collection)...\n');

      for (const { uid, data } of userDocs) {
        const { normalized, changes, hasChanges, error } = normalizeUserDoc(uid, data);

        if (error) {
          console.log(`❌ User ${data.email || uid}: SKIPPED (critical error)`);
          changes.forEach(change => console.log(`   ${change}`));
          results.errors.push({ type: 'user', uid, email: data.email, changes });
          continue;
        }

        if (hasChanges) {
          results.usersCleaned++;
          console.log(`👤 User: ${data.email}`);
          changes.forEach(change => console.log(`   ${change}`));

          if (!DRY_RUN) {
            await firestore.collection('users').doc(uid).set(normalized);
            console.log(`   ✅ Updated users/${uid}`);
          } else {
            console.log(`   [DRY-RUN: would update users/${uid}]`);
          }
          console.log('');

          results.details.push({
            type: 'user-cleaned',
            uid,
            email: data.email,
            changes,
          });
        }

        // Process profile
        const profileData = profilesMap[uid];
        const { normalized: normalizedProfile, changes: profileChanges, hasChanges: profileHasChanges, error: profileError } 
          = normalizeProfileDoc(uid, profileData, normalized.name, normalized.createdAt);

        if (profileError) {
          console.log(`❌ Profile for ${data.email}: SKIPPED (critical error)`);
          profileChanges.forEach(change => console.log(`   ${change}`));
          results.errors.push({ type: 'profile', uid, email: data.email, changes: profileChanges });
          continue;
        }

        if (profileHasChanges || !profileData) {
          results.profilesNormalized++;
          console.log(`📋 Profile for ${data.email}`);
          profileChanges.forEach(change => console.log(`   ${change}`));

          if (!DRY_RUN) {
            await firestore.collection('profiles').doc(uid).set(normalizedProfile);
            console.log(`   ✅ ${profileData ? 'Updated' : 'Created'} profiles/${uid}`);
          } else {
            console.log(`   [DRY-RUN: would ${profileData ? 'update' : 'create'} profiles/${uid}]`);
          }
          console.log('');

          results.details.push({
            type: 'profile-normalized',
            uid,
            email: data.email,
            changes: profileChanges,
          });
        }
      }
    }

    // ===== SUMMARY =====
    console.log('\n╔════════════════════════════════════════════════════════╗');
    console.log('║                   MIGRATION SUMMARY                   ║');
    console.log('╚════════════════════════════════════════════════════════╝\n');

    console.log('📊 Statistics:');
    console.log(`  • Admins found: ${results.adminsFound}`);
    console.log(`  • Admins migrated to admins/ collection: ${results.adminsMigrated}`);
    console.log(`  • Admin profiles deleted: ${results.adminProfilesDeleted}`);
    console.log(`  • Regular users found: ${results.usersFound}`);
    console.log(`  • Users cleaned: ${results.usersCleaned}`);
    console.log(`  • Profiles normalized: ${results.profilesNormalized}`);
    console.log(`  • Errors: ${results.errors.length}\n`);

    if (results.errors.length > 0) {
      console.log('❌ Errors encountered:');
      results.errors.forEach(err => {
        console.log(`  • ${err.type} ${err.email || err.uid}: ${err.changes.join(', ')}`);
      });
      console.log('');
    }

    if (DRY_RUN) {
      console.log('🔍 DRY-RUN COMPLETE - No changes were written.\n');
      console.log('📋 Review the changes above. Run without --dry-run to apply them:\n');
      console.log('   node backend/scripts/migrateAdminUserSeparation.js\n');
    } else {
      console.log('✅ MIGRATION COMPLETE\n');
      console.log('📋 Next steps:');
      console.log('   1. Deploy updated Firestore rules');
      console.log('   2. Update backend code to use new collections');
      console.log('   3. Test admin and user flows\n');
    }

  } catch (error) {
    console.error('❌ Fatal error during migration:', error);
    process.exit(1);
  }
};

/**
 * Rollback function (moves admins back to users collection)
 */
const rollback = async () => {
  console.log('\n╔════════════════════════════════════════════════════════╗');
  console.log('║              ROLLBACK: Admins → Users                 ║');
  console.log('╚════════════════════════════════════════════════════════╝\n');

  if (DRY_RUN) {
    console.log('🔍 DRY-RUN MODE - Preview rollback\n');
  } else {
    console.log('⚠️  LIVE MODE - Rolling back migration\n');
  }

  try {
    const adminsSnapshot = await firestore.collection('admins').get();
    const adminDocs = adminsSnapshot.docs;

    console.log(`📥 Found ${adminDocs.length} admins to rollback\n`);

    for (const doc of adminDocs) {
      const uid = doc.id;
      const data = doc.data();

      console.log(`👤 Rolling back admin: ${data.email}`);

      const rolledBackData = {
        ...data,
        role: 'admin',
        updatedAt: admin.firestore.Timestamp.now(),
      };

      if (!DRY_RUN) {
        await firestore.collection('users').doc(uid).set(rolledBackData);
        await firestore.collection('admins').doc(uid).delete();
        console.log(`   ✅ Moved back to users/${uid}`);
        console.log(`   🗑️  Deleted from admins/${uid}\n`);
      } else {
        console.log(`   [DRY-RUN: would move to users/${uid}]`);
        console.log(`   [DRY-RUN: would delete from admins/${uid}]\n`);
      }
    }

    console.log(`\n✅ Rollback ${DRY_RUN ? 'preview' : 'complete'}\n`);

  } catch (error) {
    console.error('❌ Fatal error during rollback:', error);
    process.exit(1);
  }
};

// ============ MAIN EXECUTION ============

if (ROLLBACK) {
  rollback();
} else {
  migrate();
}
