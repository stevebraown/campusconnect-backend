#!/usr/bin/env node
/**
 * Fix orphaned user with missing email
 * Fetches email from Firebase Auth and updates Firestore
 */

import 'dotenv/config';
import admin, { firestore, firebaseAuth } from '../config/firebaseAdmin.js';

const UID = 'OYazJx6IhJWntOiBJeGOgjpvKAN2';

async function fixOrphanedUser() {
  console.log(`\n🔧 Fixing orphaned user: ${UID}\n`);
  
  try {
    // Get user from Firebase Auth
    const userRecord = await firebaseAuth.getUser(UID);
    
    if (!userRecord.email) {
      console.log('❌ User has no email in Firebase Auth either');
      console.log('🗑️  Recommendation: Delete this user document');
      console.log(`   firebase auth:delete ${UID}`);
      return;
    }
    
    console.log(`✅ Found email in Firebase Auth: ${userRecord.email}`);
    
    // Update Firestore document
    await firestore.collection('users').doc(UID).update({
      email: userRecord.email,
      updatedAt: admin.firestore.Timestamp.now(),
    });
    
    console.log(`✅ Updated Firestore document with email\n`);
    console.log('📋 Now re-run migration to complete normalization:');
    console.log('   node scripts/migrateAdminUserSeparation.js\n');
    
  } catch (error) {
    if (error.code === 'auth/user-not-found') {
      console.log('❌ User not found in Firebase Auth');
      console.log('🗑️  This is an orphaned Firestore document');
      console.log('🗑️  Safe to delete:');
      console.log(`   • firestore.collection('users').doc('${UID}').delete()`);
      console.log(`   • firestore.collection('profiles').doc('${UID}').delete()`);
    } else {
      console.error('❌ Error:', error);
    }
  }
}

fixOrphanedUser();
