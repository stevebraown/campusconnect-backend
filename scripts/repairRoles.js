#!/usr/bin/env node
/**
 * Role Repair Script
 * 
 * Scans all users in Firebase Auth and Firestore, then enforces role consistency:
 * - Reads role from Firestore (source of truth)
 * - Falls back to ADMIN_EMAILS check if Firestore doesn't exist
 * - Updates Firestore and custom claims to match the resolved role
 * 
 * Usage:
 *   node backend/scripts/repairRoles.js
 * 
 * This script should be run:
 * - After initial setup
 * - After bulk role changes
 * - When role inconsistencies are detected
 */

import 'dotenv/config';
import { firebaseAuth } from '../config/firebaseAdmin.js';
import {
  resolveExpectedRole,
  getRoleFromFirestore,
  syncRoleToAllSources,
  getAdminEmails,
} from '../utils/roleResolver.js';

/**
 * Get role from custom claims (for logging only)
 */
const getRoleFromClaims = async (uid) => {
  try {
    const user = await firebaseAuth.getUser(uid);
    return user.customClaims?.role || null;
  } catch (err) {
    console.error(`❌ Error reading custom claims for ${uid}:`, err.message);
  }
  return null;
};

/**
 * Repair role for a single user
 */
const repairUserRole = async (uid, email) => {
  const previousFirestoreRole = await getRoleFromFirestore(uid);
  const previousClaimRole = await getRoleFromClaims(uid);
  const expectedRole = await resolveExpectedRole(uid, email);
  
  const changes = [];
  
  // Check if repair is needed
  const needsFirestoreUpdate = previousFirestoreRole !== expectedRole;
  const needsClaimUpdate = previousClaimRole !== expectedRole;
  
  if (!needsFirestoreUpdate && !needsClaimUpdate) {
    return {
      success: true,
      previousFirestoreRole: previousFirestoreRole || 'none',
      previousClaimRole: previousClaimRole || 'none',
      expectedRole,
      changes: [],
    };
  }
  
  // Use shared sync function to update both sources
  try {
    const updates = await syncRoleToAllSources(firebaseAuth, uid, email, expectedRole);
    changes.push(...updates);
  } catch (err) {
    console.error(`  ❌ Failed to sync role for ${uid}:`, err.message);
    return { success: false, error: err.message };
  }
  
  return {
    success: true,
    previousFirestoreRole: previousFirestoreRole || 'none',
    previousClaimRole: previousClaimRole || 'none',
    expectedRole,
    changes,
  };
};

/**
 * Main repair function
 */
const repairAllRoles = async () => {
  console.log('🔧 Starting role repair process...\n');
  
  const adminEmails = getAdminEmails();
  if (adminEmails.length > 0) {
    console.log(`📋 ADMIN_EMAILS configured: ${adminEmails.join(', ')}\n`);
  } else {
    console.warn('⚠️ ADMIN_EMAILS is empty or not set.\n');
  }
  
  try {
    // List all users from Firebase Auth
    console.log('📥 Fetching all users from Firebase Auth...');
    let allUsers = [];
    let nextPageToken;
    
    do {
      const listUsersResult = await firebaseAuth.listUsers(1000, nextPageToken);
      allUsers = allUsers.concat(listUsersResult.users);
      nextPageToken = listUsersResult.pageToken;
    } while (nextPageToken);
    
    console.log(`✅ Found ${allUsers.length} users in Firebase Auth\n`);
    
    const results = {
      total: allUsers.length,
      repaired: 0,
      unchanged: 0,
      errors: 0,
      details: [],
    };
    
    // Process each user
    for (const user of allUsers) {
      const { uid, email } = user;
      const emailDisplay = email || '(no email)';
      
      console.log(`\n👤 Processing: ${emailDisplay} (${uid})`);
      
      try {
        const result = await repairUserRole(uid, email);
        
        if (result.success) {
          if (result.changes.length > 0) {
            console.log(`  ✅ Repaired:`);
            result.changes.forEach(change => console.log(`     - ${change}`));
            results.repaired++;
            results.details.push({
              email: emailDisplay,
              uid,
              previousFirestoreRole: result.previousFirestoreRole,
              previousClaimRole: result.previousClaimRole,
              expectedRole: result.expectedRole,
              status: 'repaired',
            });
          } else {
            console.log(`  ✓ Already consistent (role: ${result.expectedRole})`);
            results.unchanged++;
            results.details.push({
              email: emailDisplay,
              uid,
              previousFirestoreRole: result.previousFirestoreRole,
              previousClaimRole: result.previousClaimRole,
              expectedRole: result.expectedRole,
              status: 'unchanged',
            });
          }
        } else {
          console.log(`  ❌ Error: ${result.error}`);
          results.errors++;
          results.details.push({
            email: emailDisplay,
            uid,
            status: 'error',
            error: result.error,
          });
        }
      } catch (err) {
        console.error(`  ❌ Unexpected error:`, err.message);
        results.errors++;
        results.details.push({
          email: emailDisplay,
          uid,
          status: 'error',
          error: err.message,
        });
      }
    }
    
    // Summary
    console.log('\n' + '='.repeat(60));
    console.log('📊 REPAIR SUMMARY');
    console.log('='.repeat(60));
    console.log(`Total users:     ${results.total}`);
    console.log(`Repaired:        ${results.repaired}`);
    console.log(`Unchanged:       ${results.unchanged}`);
    console.log(`Errors:          ${results.errors}`);
    console.log('='.repeat(60));
    
    if (results.repaired > 0) {
      console.log('\n✅ Role repair completed! Users will get updated roles on next login.');
    } else if (results.errors === 0) {
      console.log('\n✅ All roles are already consistent!');
    } else {
      console.log('\n⚠️ Repair completed with some errors. Check logs above.');
    }
    
    return results;
  } catch (err) {
    console.error('\n❌ Fatal error during repair:', err);
    process.exit(1);
  }
};

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  repairAllRoles()
    .then(() => {
      console.log('\n✅ Script completed successfully');
      process.exit(0);
    })
    .catch((err) => {
      console.error('\n❌ Script failed:', err);
      process.exit(1);
    });
}

export { repairAllRoles, repairUserRole, resolveExpectedRole };
