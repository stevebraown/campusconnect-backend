// Authentication and session-related routes
import express from 'express';
import { firebaseAuth, firestore } from '../config/firebaseAdmin.js';
import { signToken } from '../utils/jwt.js';
import { requireAuth } from '../middleware/auth.js';
import {
  resolveExpectedRole,
  resolveRoleFromEmail,
  getRoleFromFirestore,
  syncRoleToAllSources,
  getAdminEmails,
} from '../utils/roleResolver.js';

const router = express.Router();

const FIREBASE_API_KEY = process.env.FIREBASE_API_KEY;
const FIREBASE_AUTH_BASE = 'https://identitytoolkit.googleapis.com/v1';

const usersRef = firestore.collection('users');
const profilesRef = firestore.collection('profiles');
const adminsRef = firestore.collection('admins');

const sendError = (res, status, message) => res.status(status).json({ success: false, error: message });

const callFirebaseAuth = async (path, body) => {
  if (!FIREBASE_API_KEY) {
    throw new Error('FIREBASE_API_KEY is missing');
  }

  const res = await fetch(`${FIREBASE_AUTH_BASE}/${path}?key=${FIREBASE_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = data?.error?.message || `Firebase auth error (${res.status})`;
    throw new Error(message);
  }

  return data;
};

// Log admin emails on startup for debugging
const adminEmails = getAdminEmails();
if (adminEmails.length > 0) {
  console.log(`📋 ADMIN_EMAILS configured: ${adminEmails.join(', ')}`);
} else {
  console.warn('⚠️ ADMIN_EMAILS is empty or not set. No emails will be auto-promoted to admin.');
}

router.post('/register', async (req, res) => {
  try {
    const { email, password, name } = req.body || {};
    if (!email || !password) return sendError(res, 400, 'email and password are required');

    const authData = await callFirebaseAuth('accounts:signUp', {
      email,
      password,
      returnSecureToken: true,
    });

    const decoded = await firebaseAuth.verifyIdToken(authData.idToken);

    // Resolve role using shared logic (Firestore > ADMIN_EMAILS > 'user')
    const role = await resolveExpectedRole(decoded.uid, decoded.email || '');

    // Sync role to all sources (Firestore + custom claims)
    const syncUpdates = await syncRoleToAllSources(firebaseAuth, decoded.uid, decoded.email, role);
    console.log(`✅ Register synced role for ${decoded.email}: ${syncUpdates.join(', ')}`);

    const displayName = name || decoded.email?.split('@')?.[0] || '';

    if (role === 'admin') {
      await adminsRef.doc(decoded.uid).set({
        name: displayName,
        email: decoded.email,
        updatedAt: new Date().toISOString(),
      }, { merge: true });
    } else {
      await usersRef.doc(decoded.uid).set({
        name: displayName,
        email: decoded.email,
        role: 'user',
        updatedAt: new Date().toISOString(),
      }, { merge: true });

      await profilesRef.doc(decoded.uid).set({
        uid: decoded.uid,
        name: displayName,
        major: '',
        year: null,
        interests: [],
        bio: '',
        avatarUrl: '',
        locationEnabled: false,
        updatedAt: new Date().toISOString(),
      }, { merge: true });
    }

    // Issue JWT with resolved role (single source of truth)
    const jwt = signToken({ uid: decoded.uid, email: decoded.email, role });

    return res.json({
      success: true,
      token: jwt,
      user: { uid: decoded.uid, email: decoded.email, name: displayName, role },
    });
  } catch (err) {
    console.error('Register error:', err);
    return sendError(res, 400, err.message || 'Registration failed');
  }
});

router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return sendError(res, 400, 'email and password are required');

    const authData = await callFirebaseAuth('accounts:signInWithPassword', {
      email,
      password,
      returnSecureToken: true,
    });

    console.log('🔍 Verifying ID token...');
    const decoded = await firebaseAuth.verifyIdToken(authData.idToken);
    console.log('✅ Token verified:', decoded.email);
    
    // Resolve role using shared logic (Firestore > ADMIN_EMAILS > 'user')
    const expectedRole = await resolveExpectedRole(decoded.uid, decoded.email || '');
    const firestoreRole = await getRoleFromFirestore(decoded.uid);
    const emailRole = resolveRoleFromEmail(decoded.email || '');
    const existingClaimRole = decoded.role || 'user';
    
    console.log(`🔍 Role resolution for ${decoded.email}: Firestore=${firestoreRole || 'none'}, Email=${emailRole}, Claim=${existingClaimRole} → Expected=${expectedRole}`);

    // Sync role to all sources if it changed
    if (existingClaimRole !== expectedRole || !firestoreRole) {
      const syncUpdates = await syncRoleToAllSources(firebaseAuth, decoded.uid, decoded.email, expectedRole);
      console.log(`✅ Synced role for ${decoded.email}: ${syncUpdates.join(', ')}`);
    }

    // Issue JWT with the resolved role (single source of truth)
    const jwt = signToken({ uid: decoded.uid, email: decoded.email, role: expectedRole });

    return res.json({
      success: true,
      token: jwt,
      user: { uid: decoded.uid, email: decoded.email, role: expectedRole },
    });
  } catch (err) {
    console.error('❌ Login error:', err);
    console.error('Error code:', err.code);
    console.error('Error message:', err.message);
    return sendError(res, 400, err.message || 'Login failed');
  }
});

// Simple authenticated echo endpoint
router.get('/me', requireAuth, async (req, res) => {
  try {
    return res.json({
      success: true,
      user: {
        uid: req.user.uid,
        email: req.user.email,
        role: req.user.role,
        name: req.user?.data?.name,
      },
    });
  } catch (err) {
    console.error('Error in /me endpoint:', err);
    return sendError(res, 500, 'Failed to load session');
  }
});

router.post('/logout', requireAuth, async (req, res) => {
  return res.json({ success: true });
});

router.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body || {};
    if (!email) return sendError(res, 400, 'email is required');

    await callFirebaseAuth('accounts:sendOobCode', {
      requestType: 'PASSWORD_RESET',
      email,
    });

    return res.json({ success: true });
  } catch (err) {
    console.error('Forgot password error:', err);
    return sendError(res, 400, err.message || 'Password reset failed');
  }
});

export default router;