/**
 * Role Resolution Utility
 * 
 * Centralized logic for resolving user roles from multiple sources.
 * Source of truth priority: Firestore > ADMIN_EMAILS > 'user'
 * 
 * This ensures consistency across:
 * - Login/Register flows
 * - Role repair script
 * - Admin panel role updates
 */

import admin, { firestore } from '../config/firebaseAdmin.js';

const adminEmails = (process.env.ADMIN_EMAILS || '')
  .split(',')
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);

/**
 * Resolve role from ADMIN_EMAILS env var
 */
export const resolveRoleFromEmail = (email) => {
  if (!email) return 'user';
  return adminEmails.includes(email.toLowerCase()) ? 'admin' : 'user';
};

/**
 * Get role from Firestore (checks both admins and users collections)
 * @param {string} uid - User ID
 * @returns {Promise<string|null>} - 'admin', 'user', or null if doc doesn't exist
 */
export const getRoleFromFirestore = async (uid) => {
  try {
    // Check admins collection first
    const adminRef = firestore.collection('admins').doc(uid);
    const adminSnap = await adminRef.get();
    if (adminSnap.exists) {
      return 'admin';
    }

    // Check users collection
    const userRef = firestore.collection('users').doc(uid);
    const userSnap = await userRef.get();
    if (userSnap.exists) {
      const data = userSnap.data();
      return data.role || 'user';
    }
  } catch (err) {
    console.error(`❌ Error reading Firestore role for ${uid}:`, err.message);
  }
  return null;
};

/**
 * Resolve expected role (source of truth)
 * Priority: Firestore (if exists) > ADMIN_EMAILS > 'user'
 * 
 * @param {string} uid - User ID
 * @param {string} email - User email
 * @returns {Promise<string>} - 'admin' or 'user'
 */
export const resolveExpectedRole = async (uid, email) => {
  // First, check Firestore (source of truth if it exists)
  const firestoreRole = await getRoleFromFirestore(uid);
  if (firestoreRole) {
    return firestoreRole;
  }
  
  // If Firestore doesn't exist, check ADMIN_EMAILS
  return resolveRoleFromEmail(email);
};

/**
 * Sync role across all sources (Firestore + custom claims)
 * This should be called whenever a role is changed.
 * 
 * For admins: Creates in admins/ collection (no profile)
 * For users: Creates in users/ collection + profile
 * 
 * @param {Object} firebaseAuth - Firebase Admin Auth instance
 * @param {string} uid - User ID
 * @param {string} email - User email
 * @param {string} role - Role to enforce ('admin' or 'user')
 */
export const syncRoleToAllSources = async (firebaseAuth, uid, email, role) => {
  const updates = [];
  
  // Determine if this is an admin
  const isAdmin = role === 'admin';
  
  // Update Firestore
  try {
    if (isAdmin) {
      // Create/update admin document
      const adminRef = firestore.collection('admins').doc(uid);
      const adminSnap = await adminRef.get();
      
      if (!adminSnap.exists) {
        await adminRef.set({
          uid,
          email,
          name: email.split('@')[0],
          createdAt: admin.firestore.Timestamp.now(),
          updatedAt: admin.firestore.Timestamp.now(),
          disabled: false,
        });
        updates.push('Firestore: created admin doc');
      } else {
        updates.push('Firestore: admin doc already exists');
      }

      // Delete from users collection if exists
      const userRef = firestore.collection('users').doc(uid);
      const userSnap = await userRef.get();
      if (userSnap.exists) {
        await userRef.delete();
        updates.push('Firestore: deleted from users collection');
      }
    } else {
      // Create/update user document
      const userRef = firestore.collection('users').doc(uid);
      const userSnap = await userRef.get();
      const tenantId = email.match(/@([^.]+)/)?.[1] || 'default';

      if (!userSnap.exists) {
        await userRef.set({
          uid,
          email,
          tenantId,
          name: email.split('@')[0],
          avatarUrl: '',
          role: 'user',
          createdAt: admin.firestore.Timestamp.now(),
          updatedAt: admin.firestore.Timestamp.now(),
          disabled: false,
        });
        updates.push('Firestore: created user doc');

        // Create profile
        await firestore.collection('profiles').doc(uid).set({
          uid,
          displayName: email.split('@')[0],
          degree: 'Not specified',
          year: 'Not specified',
          bio: '',
          interests: [],
          locationEnabled: false,
          createdAt: admin.firestore.Timestamp.now(),
          updatedAt: admin.firestore.Timestamp.now(),
          disabled: false,
        });
        updates.push('Firestore: created profile doc');
      } else {
        updates.push('Firestore: user doc already exists');
      }

      // Delete from admins collection if exists
      const adminRef = firestore.collection('admins').doc(uid);
      const adminSnap = await adminRef.get();
      if (adminSnap.exists) {
        await adminRef.delete();
        updates.push('Firestore: deleted from admins collection');
      }
    }
  } catch (err) {
    console.error(`❌ Failed to update Firestore for ${uid}:`, err.message);
    throw new Error(`Firestore update failed: ${err.message}`);
  }
  
  // Update custom claims
  try {
    const user = await firebaseAuth.getUser(uid);
    const currentClaimRole = user.customClaims?.role;
    
    if (currentClaimRole !== role) {
      await firebaseAuth.setCustomUserClaims(uid, { role });
      updates.push(`Custom claims: ${currentClaimRole || 'none'} → ${role}`);
    } else {
      updates.push('Custom claims: already correct');
    }
  } catch (err) {
    console.error(`❌ Failed to update custom claims for ${uid}:`, err.message);
    throw new Error(`Custom claims update failed: ${err.message}`);
  }
  
  return updates;
};

/**
 * Get admin emails list (for logging/debugging)
 */
export const getAdminEmails = () => [...adminEmails];
