#!/usr/bin/env node
/**
 * Admin Password Reset Script
 * 
 * Resets passwords for admin accounts and ensures their roles are correct.
 * 
 * ⚠️ IMPORTANT: Edit NEW_ADMIN_PASSWORD and NEW_SUPERADMIN_PASSWORD below before running!
 * 
 * Usage:
 *   1. Edit the password constants at the top of this file
 *   2. From the repo root, run:
 *      cd backend
 *      node scripts/resetAdminPasswords.js
 * 
 * Or using npm script:
 *   cd backend
 *   npm run reset-admin-passwords
 * 
 * This script:
 * - Resets passwords for admin@university.edu and superadmin@university.edu
 * - Ensures both accounts have role: 'admin' in Firestore and custom claims
 * - Logs all changes and errors
 * 
 * ⚠️ SECURITY: This script is for local/admin use only. Never expose as HTTP endpoint.
 */

import 'dotenv/config';
import { firebaseAuth, firestore } from '../config/firebaseAdmin.js';
import { syncRoleToAllSources } from '../utils/roleResolver.js';

// ⚠️ EDIT THESE PASSWORDS BEFORE RUNNING THE SCRIPT ⚠️
const NEW_ADMIN_PASSWORD = 'Admin2026!Reset';
const NEW_SUPERADMIN_PASSWORD = 'SuperAdmin2026!Reset';

// Admin emails to reset
const ADMIN_EMAILS = [
  { email: 'admin@university.edu', password: NEW_ADMIN_PASSWORD },
  { email: 'superadmin@university.edu', password: NEW_SUPERADMIN_PASSWORD },
];

/**
 * Reset password for a single user
 */
const resetUserPassword = async (email, newPassword) => {
  try {
    const userRecord = await firebaseAuth.getUserByEmail(email);
    await firebaseAuth.updateUser(userRecord.uid, { password: newPassword });
    return {
      success: true,
      uid: userRecord.uid,
      email: userRecord.email,
    };
  } catch (err) {
    if (err.code === 'auth/user-not-found') {
      return {
        success: false,
        error: 'User not found',
        email,
      };
    }
    return {
      success: false,
      error: err.message,
      email,
    };
  }
};

/**
 * Verify and fix role for a user
 */
const ensureAdminRole = async (uid, email) => {
  const changes = [];
  
  try {
    // Check Firestore role
    const userRef = firestore.collection('users').doc(uid);
    const snap = await userRef.get();
    const firestoreRole = snap.exists ? (snap.data().role || 'user') : null;
    
    // Check custom claims
    const userRecord = await firebaseAuth.getUser(uid);
    const claimRole = userRecord.customClaims?.role || null;
    
    // If either is not 'admin', sync to 'admin'
    if (firestoreRole !== 'admin' || claimRole !== 'admin') {
      await syncRoleToAllSources(firebaseAuth, uid, email, 'admin');
      
      if (firestoreRole !== 'admin') {
        changes.push(`Firestore: ${firestoreRole || 'none'} → admin`);
      }
      if (claimRole !== 'admin') {
        changes.push(`Custom claims: ${claimRole || 'none'} → admin`);
      }
      
      return {
        success: true,
        wasAdmin: firestoreRole === 'admin' && claimRole === 'admin',
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
const resetAdminPasswords = async () => {
  console.log('🔐 Starting admin password reset...\n');
  console.log('⚠️  Make sure you have edited the password constants in this script!\n');
  
  const results = [];
  
  for (const { email, password } of ADMIN_EMAILS) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`👤 Processing: ${email}`);
    console.log('='.repeat(60));
    
    // Reset password
    console.log('🔑 Resetting password...');
    const passwordResult = await resetUserPassword(email, password);
    
    if (!passwordResult.success) {
      console.error(`❌ Failed to reset password: ${passwordResult.error}`);
      results.push({
        email,
        passwordReset: false,
        passwordError: passwordResult.error,
        roleCheck: null,
      });
      continue;
    }
    
    console.log(`✅ Password reset successful (UID: ${passwordResult.uid})`);
    
    // Verify and fix role
    console.log('🔍 Verifying admin role...');
    const roleResult = await ensureAdminRole(passwordResult.uid, email);
    
    if (!roleResult.success) {
      console.error(`❌ Failed to verify/fix role: ${roleResult.error}`);
      results.push({
        email,
        uid: passwordResult.uid,
        passwordReset: true,
        roleCheck: false,
        roleError: roleResult.error,
      });
      continue;
    }
    
    if (roleResult.changes.length > 0) {
      console.log(`✅ Role updated:`);
      roleResult.changes.forEach(change => console.log(`   - ${change}`));
    } else {
      console.log(`✅ Role already correct (admin)`);
    }
    
    results.push({
      email,
      uid: passwordResult.uid,
      passwordReset: true,
      roleCheck: true,
      roleWasAdmin: roleResult.wasAdmin,
      roleChanges: roleResult.changes,
    });
  }
  
  // Summary
  console.log('\n' + '='.repeat(60));
  console.log('📊 SUMMARY');
  console.log('='.repeat(60));
  
  for (const result of results) {
    if (result.passwordReset && result.roleCheck) {
      console.log(`✅ ${result.email} (${result.uid})`);
      console.log(`   Password: Reset successfully`);
      console.log(`   Role: admin${result.roleWasAdmin ? ' (already correct)' : ' (updated)'}`);
      if (result.roleChanges.length > 0) {
        result.roleChanges.forEach(change => console.log(`   - ${change}`));
      }
    } else {
      console.log(`❌ ${result.email}`);
      if (!result.passwordReset) {
        console.log(`   Password: Failed - ${result.passwordError}`);
      }
      if (result.roleCheck === false) {
        console.log(`   Role: Failed - ${result.roleError}`);
      }
    }
    console.log('');
  }
  
  const successCount = results.filter(r => r.passwordReset && r.roleCheck).length;
  const totalCount = results.length;
  
  console.log('='.repeat(60));
  console.log(`✅ Successfully processed: ${successCount}/${totalCount} accounts`);
  console.log('='.repeat(60));
  
  if (successCount === totalCount) {
    console.log('\n✅ All admin accounts are ready!');
    console.log('   You can now log in with the new passwords.');
  } else {
    console.log('\n⚠️  Some accounts failed. Check the errors above.');
  }
};

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  resetAdminPasswords()
    .then(() => {
      console.log('\n✅ Script completed');
      process.exit(0);
    })
    .catch((err) => {
      console.error('\n❌ Script failed:', err);
      process.exit(1);
    });
}

export { resetAdminPasswords };
