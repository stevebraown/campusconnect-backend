#!/usr/bin/env node
/**
 * Ensure Test Admin Accounts Script
 * 
 * Ensures admin accounts exist with known passwords and correct roles.
 * 
 * ⚠️ IMPORTANT: Edit the KNOWN_PASSWORD constants below if needed!
 * 
 * Usage:
 *   1. Edit the password constants at the top of this file if needed
 *   2. From the repo root, run:
 *      cd backend
 *      node scripts/ensureTestAdmins.js
 * 
 * Or using npm script:
 *   cd backend
 *   npm run ensure-test-admins
 * 
 * This script:
 * - Ensures admin@university.edu and superadmin@university.edu exist
 * - Sets their passwords to known values
 * - Ensures both accounts have role: 'admin' in Firestore and custom claims
 * - Logs all operations clearly
 * 
 * ⚠️ SECURITY: This script is for local/admin use only. Never expose as HTTP endpoint.
 */

import 'dotenv/config';
import { firebaseAuth, firestore } from '../config/firebaseAdmin.js';
import { syncRoleToAllSources } from '../utils/roleResolver.js';

// ⚠️ EDIT THESE PASSWORDS IF NEEDED ⚠️
const ADMIN_PASSWORD = 'Admin2025!Reset';
const SUPERADMIN_PASSWORD = 'SuperAdmin2025!Reset';

// Admin emails to ensure
const ADMIN_ACCOUNTS = [
  { email: 'admin@university.edu', password: ADMIN_PASSWORD },
  { email: 'superadmin@university.edu', password: SUPERADMIN_PASSWORD },
];

/**
 * Ensure user exists and has correct password
 */
const ensureUserExists = async (email, password) => {
  try {
    // Try to get user by email
    const userRecord = await firebaseAuth.getUserByEmail(email);
    console.log(`   ✅ Found existing user`);
    console.log(`   📋 UID: ${userRecord.uid}`);
    
    // Update password to known value
    await firebaseAuth.updateUser(userRecord.uid, { password });
    console.log(`   🔑 Password set to: ${password}`);
    
    return {
      success: true,
      uid: userRecord.uid,
      email: userRecord.email,
      wasCreated: false,
    };
  } catch (err) {
    if (err.code === 'auth/user-not-found') {
      // User doesn't exist, create it
      console.log(`   ⚠️  User not found, creating new user...`);
      
      try {
        const userRecord = await firebaseAuth.createUser({
          email,
          password,
          emailVerified: true, // Mark email as verified for admin accounts
        });
        
        console.log(`   ✅ Created new user`);
        console.log(`   📋 UID: ${userRecord.uid}`);
        console.log(`   🔑 Password set to: ${password}`);
        
        return {
          success: true,
          uid: userRecord.uid,
          email: userRecord.email,
          wasCreated: true,
        };
      } catch (createErr) {
        console.error(`   ❌ Failed to create user: ${createErr.message}`);
        return {
          success: false,
          error: createErr.message,
          email,
        };
      }
    } else {
      console.error(`   ❌ Error getting user: ${err.message}`);
      return {
        success: false,
        error: err.message,
        email,
      };
    }
  }
};

/**
 * Ensure user has admin role
 */
const ensureAdminRole = async (uid, email) => {
  try {
    // Check current state
    const userRef = firestore.collection('users').doc(uid);
    const snap = await userRef.get();
    const firestoreRole = snap.exists ? (snap.data().role || 'user') : null;
    
    const userRecord = await firebaseAuth.getUser(uid);
    const claimRole = userRecord.customClaims?.role || null;
    
    // If either is not 'admin', sync to 'admin'
    if (firestoreRole !== 'admin' || claimRole !== 'admin') {
      await syncRoleToAllSources(firebaseAuth, uid, email, 'admin');
      
      const changes = [];
      if (firestoreRole !== 'admin') {
        changes.push(`Firestore: ${firestoreRole || 'none'} → admin`);
      }
      if (claimRole !== 'admin') {
        changes.push(`Custom claims: ${claimRole || 'none'} → admin`);
      }
      
      return {
        success: true,
        wasAdmin: false,
        changes,
      };
    }
    
    return {
      success: true,
      wasAdmin: true,
      changes: [],
    };
  } catch (err) {
    return {
      success: false,
      error: err.message,
      changes: [],
    };
  }
};

/**
 * Main function
 */
const ensureTestAdmins = async () => {
  console.log('🔧 Ensuring test admin accounts...\n');
  console.log('⚠️  Make sure passwords are correct for your needs!\n');
  
  const results = [];
  
  for (const { email, password } of ADMIN_ACCOUNTS) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`👤 Processing: ${email}`);
    console.log('='.repeat(60));
    
    // Ensure user exists with correct password
    const userResult = await ensureUserExists(email, password);
    
    if (!userResult.success) {
      console.error(`❌ Failed: ${userResult.error}`);
      results.push({
        email,
        success: false,
        error: userResult.error,
      });
      continue;
    }
    
    // Ensure admin role
    console.log(`   🔍 Ensuring admin role...`);
    const roleResult = await ensureAdminRole(userResult.uid, email);
    
    if (!roleResult.success) {
      console.error(`   ❌ Failed to set admin role: ${roleResult.error}`);
      results.push({
        email,
        uid: userResult.uid,
        passwordSet: true,
        roleSet: false,
        error: roleResult.error,
      });
      continue;
    }
    
    if (roleResult.changes.length > 0) {
      console.log(`   ✅ Role updated:`);
      roleResult.changes.forEach(change => console.log(`      - ${change}`));
    } else {
      console.log(`   ✅ Role already set to admin`);
    }
    
    console.log(`\n   📝 Summary for ${email}:`);
    console.log(`      - UID: ${userResult.uid}`);
    console.log(`      - Password: ${password}`);
    console.log(`      - Role: admin (Firestore + Custom claims)`);
    
    results.push({
      email,
      uid: userResult.uid,
      password,
      passwordSet: true,
      roleSet: true,
      wasCreated: userResult.wasCreated,
      roleWasAdmin: roleResult.wasAdmin,
    });
  }
  
  // Final summary
  console.log('\n' + '='.repeat(60));
  console.log('📊 FINAL SUMMARY');
  console.log('='.repeat(60));
  
  for (const result of results) {
    if (result.passwordSet && result.roleSet) {
      console.log(`✅ ${result.email}`);
      console.log(`   UID: ${result.uid}`);
      console.log(`   Password: ${result.password}`);
      console.log(`   Role: admin`);
      if (result.wasCreated) {
        console.log(`   Status: Created new account`);
      } else {
        console.log(`   Status: Updated existing account`);
      }
    } else {
      console.log(`❌ ${result.email}`);
      if (!result.passwordSet) {
        console.log(`   Password: Failed`);
      }
      if (!result.roleSet) {
        console.log(`   Role: Failed - ${result.error}`);
      }
    }
    console.log('');
  }
  
  const successCount = results.filter(r => r.passwordSet && r.roleSet).length;
  const totalCount = results.length;
  
  console.log('='.repeat(60));
  console.log(`✅ Successfully processed: ${successCount}/${totalCount} accounts`);
  console.log('='.repeat(60));
  
  if (successCount === totalCount) {
    console.log('\n✅ All admin accounts are ready!');
    console.log('\n📋 Login Credentials:');
    console.log(`   Email: admin@university.edu`);
    console.log(`   Password: ${ADMIN_PASSWORD}`);
    console.log(`\n   Email: superadmin@university.edu`);
    console.log(`   Password: ${SUPERADMIN_PASSWORD}`);
    console.log('\n✅ You can now log in with these credentials and access /admin');
  } else {
    console.log('\n⚠️  Some accounts failed. Check the errors above.');
  }
};

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  ensureTestAdmins()
    .then(() => {
      console.log('\n✅ Script completed');
      process.exit(0);
    })
    .catch((err) => {
      console.error('\n❌ Script failed:', err);
      process.exit(1);
    });
}

export { ensureTestAdmins };
