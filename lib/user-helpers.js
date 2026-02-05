/**
 * User/Admin Helper Functions
 * 
 * Provides utilities to distinguish between admins and users,
 * and retrieve documents from the correct collections.
 */

import { firestore } from '../config/firebaseAdmin.js';

/**
 * Check if a UID belongs to an admin
 * @param {string} uid - User ID
 * @returns {Promise<boolean>}
 */
export async function isAdmin(uid) {
  try {
    const adminDoc = await firestore.collection('admins').doc(uid).get();
    return adminDoc.exists;
  } catch (error) {
    console.error(`Error checking if ${uid} is admin:`, error);
    return false;
  }
}

/**
 * Get admin document from admins/{uid}
 * @param {string} uid - Admin ID
 * @returns {Promise<Object|null>} Admin document or null if not found
 */
export async function getAdminDoc(uid) {
  try {
    const adminDoc = await firestore.collection('admins').doc(uid).get();
    if (!adminDoc.exists) {
      return null;
    }
    return { uid, ...adminDoc.data() };
  } catch (error) {
    console.error(`Error fetching admin doc for ${uid}:`, error);
    return null;
  }
}

/**
 * Get user document from users/{uid}
 * @param {string} uid - User ID
 * @returns {Promise<Object|null>} User document or null if not found
 */
export async function getUserDoc(uid) {
  try {
    const userDoc = await firestore.collection('users').doc(uid).get();
    if (!userDoc.exists) {
      return null;
    }
    return { uid, ...userDoc.data() };
  } catch (error) {
    console.error(`Error fetching user doc for ${uid}:`, error);
    return null;
  }
}

/**
 * Get profile document from profiles/{uid}
 * @param {string} uid - User ID
 * @returns {Promise<Object|null>} Profile document or null if not found
 */
export async function getUserProfile(uid) {
  try {
    const profileDoc = await firestore.collection('profiles').doc(uid).get();
    if (!profileDoc.exists) {
      return null;
    }
    return { uid, ...profileDoc.data() };
  } catch (error) {
    console.error(`Error fetching profile for ${uid}:`, error);
    return null;
  }
}

/**
 * Get complete user data (user doc + profile)
 * @param {string} uid - User ID
 * @returns {Promise<Object|null>} Combined user+profile data or null
 */
export async function getUserWithProfile(uid) {
  try {
    const [userDoc, profileDoc] = await Promise.all([
      getUserDoc(uid),
      getUserProfile(uid),
    ]);

    if (!userDoc) {
      return null;
    }

    return {
      ...userDoc,
      profile: profileDoc,
    };
  } catch (error) {
    console.error(`Error fetching user with profile for ${uid}:`, error);
    return null;
  }
}

/**
 * Get account document (checks admins first, then users)
 * @param {string} uid - User ID
 * @returns {Promise<{type: 'admin'|'user', data: Object}|null>}
 */
export async function getAccount(uid) {
  try {
    // Check admins first
    const adminDoc = await getAdminDoc(uid);
    if (adminDoc) {
      return { type: 'admin', data: adminDoc };
    }

    // Check users
    const userDoc = await getUserWithProfile(uid);
    if (userDoc) {
      return { type: 'user', data: userDoc };
    }

    return null;
  } catch (error) {
    console.error(`Error fetching account for ${uid}:`, error);
    return null;
  }
}

/**
 * Check if a user is disabled (works for both admins and users)
 * @param {string} uid - User ID
 * @returns {Promise<boolean>}
 */
export async function isDisabled(uid) {
  try {
    const account = await getAccount(uid);
    if (!account) {
      return true; // Treat non-existent accounts as disabled
    }
    return account.data.disabled === true;
  } catch (error) {
    console.error(`Error checking if ${uid} is disabled:`, error);
    return true; // Fail-safe: treat errors as disabled
  }
}

/**
 * Request account deletion for a user
 * Creates a deletion request document for admin review
 * @param {string} uid - User ID
 * @param {string} reason - Reason for deletion
 * @returns {Promise<boolean>} Success status
 */
export async function requestUserDeletion(uid, reason = 'User requested') {
  try {
    const userDoc = await getUserDoc(uid);
    if (!userDoc) {
      throw new Error('User not found');
    }

    // Create deletion request
    await firestore.collection('deletion_requests').doc(uid).set({
      uid,
      email: userDoc.email,
      name: userDoc.name,
      reason,
      requestedAt: admin.firestore.Timestamp.now(),
      status: 'pending', // 'pending', 'approved', 'rejected'
    });

    // Mark user as disabled (soft-delete)
    await firestore.collection('users').doc(uid).update({
      disabled: true,
      updatedAt: admin.firestore.Timestamp.now(),
    });

    // Mark profile as disabled
    const profileDoc = await getUserProfile(uid);
    if (profileDoc) {
      await firestore.collection('profiles').doc(uid).update({
        disabled: true,
        updatedAt: admin.firestore.Timestamp.now(),
      });
    }

    return true;
  } catch (error) {
    console.error(`Error requesting deletion for ${uid}:`, error);
    return false;
  }
}

/**
 * Approve a deletion request and hard-delete user data
 * @param {string} uid - User ID
 * @param {string} adminUid - Admin who approved
 * @returns {Promise<boolean>} Success status
 */
export async function approveDeletion(uid, adminUid) {
  try {
    // Verify admin
    const isAdminUser = await isAdmin(adminUid);
    if (!isAdminUser) {
      throw new Error('Only admins can approve deletions');
    }

    // Delete user document
    await firestore.collection('users').doc(uid).delete();

    // Delete profile
    await firestore.collection('profiles').doc(uid).delete();

    // Update deletion request
    await firestore.collection('deletion_requests').doc(uid).update({
      status: 'approved',
      approvedBy: adminUid,
      approvedAt: admin.firestore.Timestamp.now(),
    });

    return true;
  } catch (error) {
    console.error(`Error approving deletion for ${uid}:`, error);
    return false;
  }
}

/**
 * Reject a deletion request and restore user account
 * @param {string} uid - User ID
 * @param {string} adminUid - Admin who rejected
 * @returns {Promise<boolean>} Success status
 */
export async function rejectDeletion(uid, adminUid) {
  try {
    // Verify admin
    const isAdminUser = await isAdmin(adminUid);
    if (!isAdminUser) {
      throw new Error('Only admins can reject deletions');
    }

    // Re-enable user
    await firestore.collection('users').doc(uid).update({
      disabled: false,
      updatedAt: admin.firestore.Timestamp.now(),
    });

    // Re-enable profile
    const profileDoc = await getUserProfile(uid);
    if (profileDoc) {
      await firestore.collection('profiles').doc(uid).update({
        disabled: false,
        updatedAt: admin.firestore.Timestamp.now(),
      });
    }

    // Update deletion request
    await firestore.collection('deletion_requests').doc(uid).update({
      status: 'rejected',
      rejectedBy: adminUid,
      rejectedAt: admin.firestore.Timestamp.now(),
    });

    return true;
  } catch (error) {
    console.error(`Error rejecting deletion for ${uid}:`, error);
    return false;
  }
}

/**
 * Get all pending deletion requests
 * @returns {Promise<Array>} Array of deletion requests
 */
export async function getPendingDeletions() {
  try {
    const snapshot = await firestore
      .collection('deletion_requests')
      .where('status', '==', 'pending')
      .orderBy('requestedAt', 'desc')
      .get();

    return snapshot.docs.map(doc => ({ uid: doc.id, ...doc.data() }));
  } catch (error) {
    console.error('Error fetching pending deletions:', error);
    return [];
  }
}
