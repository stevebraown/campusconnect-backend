// Admin API routes for management tasks
import express from 'express';
import { firestore, firebaseAuth } from '../config/firebaseAdmin.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { asyncHandler, sendSuccess, sendError } from '../middleware/errorHandler.js';
import { validateQuery, validateBody, validateParams } from '../middleware/validation.js';
import { syncRoleToAllSources } from '../utils/roleResolver.js';
import { validateUserDoc, validateProfileDoc, validateProfileUpdate } from '../lib/validateUser.js';
// AI service client used for admin monitoring calls.
import { runAiGraph } from '../services/aiServiceClient.js';

const router = express.Router();

// All admin routes require authentication and admin role
router.use(requireAuth, requireAdmin);

// Helper: Safely parse JSON from query strings for admin test endpoints.
const safeParseJson = (value) => {
  if (!value || typeof value !== 'string') return null;
  try {
    return JSON.parse(value);
  } catch (err) {
    return null;
  }
};

// Helper: Build basic matching metrics from AI response (admin monitoring).
const buildMatchingMetrics = (aiResponse, latencyMs) => {
  const candidates = aiResponse?.data?.candidates || [];
  const filtered = aiResponse?.data?.filtered_candidates || [];
  const finalMatches = aiResponse?.data?.final_matches || [];

  return {
    latencyMs,
    totalCandidates: candidates.length,
    filteredCount: filtered.length || candidates.length,
    finalMatchesCount: finalMatches.length,
  };
};

// Helper: Build basic events/groups metrics from AI response (admin monitoring).
const buildEventsGroupsMetrics = (aiResponse, latencyMs) => {
  const events = aiResponse?.data?.events || [];
  const groups = aiResponse?.data?.groups || [];

  return {
    latencyMs,
    eventsCount: events.length,
    groupsCount: groups.length,
  };
};

// ============ AI MONITORING ============

// Admin-only AI matching test → graph: matching.
router.get('/ai/matching/test',
  validateQuery({
    userId: { type: 'string', required: true },
    tenantId: { type: 'string', required: true },
    preferences: { type: 'string', required: false },
  }),
  asyncHandler(async (req, res) => {
    const { userId, tenantId, preferences } = req.query;
    const parsedPreferences = safeParseJson(preferences) || {};

    const requestPayload = {
      graph: 'matching',
      input: {
        user_id: userId,
        tenant_id: tenantId,
        preferences: parsedPreferences,
      },
    };

    const startTime = Date.now();
    try {
      const aiResponse = await runAiGraph(requestPayload);
      const latencyMs = Date.now() - startTime;

      return sendSuccess(res, {
        graph: 'matching',
        request: requestPayload,
        response: aiResponse,
        metrics: buildMatchingMetrics(aiResponse, latencyMs),
      });
    } catch (err) {
      console.error('Admin AI matching test error:', err);
      return sendError(res, 502, 'AI matching test failed', err?.payload || err?.message);
    }
  })
);

// Admin-only AI events/groups test → graph: events_communities.
router.get('/ai/events-groups/test',
  validateQuery({
    userId: { type: 'string', required: true },
    tenantId: { type: 'string', required: true },
    interests: { type: 'string', required: false },
    location: { type: 'string', required: false },
    limit: { type: 'number', required: false, min: 1, max: 50 },
  }),
  asyncHandler(async (req, res) => {
    const { userId, tenantId, interests, location, limit } = req.query;
    const parsedInterests = safeParseJson(interests) || [];
    const parsedLocation = safeParseJson(location) || null;

    const requestPayload = {
      graph: 'events_communities',
      input: {
        user_id: userId,
        tenant_id: tenantId,
        interests: parsedInterests,
        location: parsedLocation,
        limit: limit ? Number(limit) : null,
      },
    };

    const startTime = Date.now();
    try {
      const aiResponse = await runAiGraph(requestPayload);
      const latencyMs = Date.now() - startTime;

      return sendSuccess(res, {
        graph: 'events_communities',
        request: requestPayload,
        response: aiResponse,
        metrics: buildEventsGroupsMetrics(aiResponse, latencyMs),
      });
    } catch (err) {
      console.error('Admin AI events/groups test error:', err);
      return sendError(res, 502, 'AI events/groups test failed', err?.payload || err?.message);
    }
  })
);

// ============ USERS MANAGEMENT ============

// Helper to list all users from Firebase Auth
const listAllUsers = async () => {
  let all = [];
  let token;
  do {
    const result = await firebaseAuth.listUsers(1000, token);
    all = all.concat(result.users);
    token = result.pageToken;
  } while (token);
  return all;
};

// Get all users with pagination
router.get('/users',
  validateQuery({
    page: { type: 'number', min: 1 },
    limit: { type: 'number', min: 1, max: 100 },
    search: { type: 'string', maxLength: 100 },
  }),
  asyncHandler(async (req, res) => {
    const { page = 1, limit = 20, search = '' } = req.query;
    const pageNum = Number(page);
    const pageSize = Number(limit);

    const allAuthUsers = await listAllUsers();
    const filteredAuthUsers = search
      ? allAuthUsers.filter((u) => (u.email || '').toLowerCase().includes(search.toLowerCase()))
      : allAuthUsers;
    const total = filteredAuthUsers.length;

    const start = (pageNum - 1) * pageSize;
    const pageAuthUsers = filteredAuthUsers.slice(start, start + pageSize);

    const users = await Promise.all(
      pageAuthUsers.map(async (u) => {
        const uid = u.uid;
        const [userDoc, profileDoc] = await Promise.all([
          firestore.collection('users').doc(uid).get(),
          firestore.collection('profiles').doc(uid).get(),
        ]);

        const userData = userDoc.exists ? userDoc.data() : {};
        const profileData = profileDoc.exists ? profileDoc.data() : {};

        const role = u.customClaims?.role || userData.role || 'user';
        return {
          uid,
          email: u.email || userData.email,
          role,
          disabled: !!u.disabled || !!userData.disabled,
          createdAt: u.metadata?.creationTime || userData.createdAt,
          name: userData.name || profileData.name || '',
          avatarUrl: userData.avatarUrl || profileData.avatarUrl || '',
          major: profileData.major || '',
          year: profileData.year || '',
          interests: profileData.interests || [],
        };
      })
    );

    return sendSuccess(res, {
      users,
      pagination: { page: pageNum, limit: pageSize, total, pages: Math.ceil(total / pageSize) },
    });
  })
);

// Create a new user (admin)
router.post('/users',
  validateBody({
    email: { required: true, type: 'string', pattern: /^[^\s@]+@[^\s@]+\.[^\s@]+$/ },
    password: { required: true, type: 'string', minLength: 6 },
    role: { type: 'string', validator: (v) => ['user', 'admin'].includes(v) || 'Invalid role' },
    name: { type: 'string', maxLength: 100 },
  }),
  asyncHandler(async (req, res) => {
    const { email, password, role = 'user', name = '' } = req.body;

    const userRecord = await firebaseAuth.createUser({
      email,
      password,
      displayName: name || undefined,
    });

    const now = firestore.Timestamp.now();

    // Create users/{uid} document with canonical schema
    const userDoc = {
      uid: userRecord.uid,
      email,
      role,
      createdAt: now,
      disabled: false,
      updatedAt: now,
    };

    // Validate schema
    const userErrors = validateUserDoc(userDoc);
    if (userErrors.length > 0) {
      await firebaseAuth.deleteUser(userRecord.uid);
      return sendError(res, 400, `Invalid user schema: ${userErrors.join(', ')}`);
    }

    await firestore.collection('users').doc(userRecord.uid).set(userDoc);

    // Use shared sync function to ensure custom claims match
    await syncRoleToAllSources(firebaseAuth, userRecord.uid, email, role);

    // Create profiles/{uid} document with canonical schema
    const profileDoc = {
      name: name || '',
      major: '',
      year: null,
      bio: '',
      interests: [],
      avatarUrl: '',
      locationEnabled: false,
      locationLat: null,
      locationLng: null,
      locationUpdatedAt: null,
      createdAt: now,
      updatedAt: now,
    };

    // Validate profile schema
    const profileErrors = validateProfileDoc(profileDoc);
    if (profileErrors.length > 0) {
      console.error(`Profile validation failed for ${email}:`, profileErrors);
      // Don't fail the request; profile validation is less critical
    }

    await firestore.collection('profiles').doc(userRecord.uid).set(profileDoc);

    return sendSuccess(res, {
      user: {
        uid: userRecord.uid,
        email,
        role,
        createdAt: now,
        disabled: false,
      },
      profile: {
        uid: userRecord.uid,
        name: name || '',
      },
    }, 201);
  })
);

// Get user details by UID
router.get('/users/:uid',
  validateParams({
    uid: { required: true },
  }),
  asyncHandler(async (req, res) => {
    const { uid } = req.params;
    const userDoc = await firestore.collection('users').doc(uid).get();
    
    if (!userDoc.exists) {
      return sendError(res, 404, 'User not found');
    }

    const profileDoc = await firestore.collection('profiles').doc(uid).get();

    return sendSuccess(res, {
      user: { uid, ...userDoc.data() },
      profile: profileDoc.exists ? { uid, ...profileDoc.data() } : null,
    });
  })
);

// Update user role
router.patch('/users/:uid/role',
  validateParams({ uid: { required: true } }),
  validateBody({
    role: { required: true, type: 'string', validator: (v) => ['user', 'admin'].includes(v) || 'Invalid role' },
  }),
  asyncHandler(async (req, res) => {
    const { uid } = req.params;
    const { role } = req.body;

    // Get user email for sync function
    const userRecord = await firebaseAuth.getUser(uid);
    const email = userRecord.email || '';

    // Use shared sync function to update both Firestore and custom claims
    await syncRoleToAllSources(firebaseAuth, uid, email, role);

    return sendSuccess(res, { message: `User role updated to ${role}` });
  })
);

// Update user profile (admin override)
router.patch('/users/:uid/profile',
  validateParams({ uid: { required: true } }),
  validateBody({
    name: { type: 'string', maxLength: 100 },
    major: { type: 'string', maxLength: 100 },
    year: { type: 'number', min: 1, max: 10 },
    interests: { type: 'array', maxItems: 50 },
    bio: { type: 'string', maxLength: 500 },
    avatarUrl: { type: 'string' },
  }),
  asyncHandler(async (req, res) => {
    const { uid } = req.params;
    const updates = req.body || {};

    // Validate profile update
    const validationErrors = validateProfileUpdate(updates);
    if (validationErrors.length > 0) {
      return sendError(res, 400, `Profile validation failed: ${validationErrors.join(', ')}`);
    }

    // Only update profile fields (not user fields)
    const allowedProfileFields = ['name', 'major', 'year', 'interests', 'bio', 'avatarUrl'];
    const profilePayload = {};
    allowedProfileFields.forEach((field) => {
      if (updates[field] !== undefined) profilePayload[field] = updates[field];
    });

    if (Object.keys(profilePayload).length > 0) {
      profilePayload.updatedAt = firestore.Timestamp.now();
      await firestore.collection('profiles').doc(uid).set(profilePayload, { merge: true });
    }

    return sendSuccess(res, { profile: profilePayload });
  })
);

// Set/reset password (admin)
router.patch('/users/:uid/password',
  validateParams({ uid: { required: true } }),
  validateBody({
    password: { required: true, type: 'string', minLength: 6 },
  }),
  asyncHandler(async (req, res) => {
    const { uid } = req.params;
    const { password } = req.body;

    await firebaseAuth.updateUser(uid, { password });
    return sendSuccess(res, { message: 'Password updated' });
  })
);

// Disable/enable user account
router.patch('/users/:uid/disable',
  validateParams({ uid: { required: true } }),
  validateBody({
    disabled: { required: true, type: 'boolean' },
  }),
  asyncHandler(async (req, res) => {
    const { uid } = req.params;
    const { disabled } = req.body;

    await firebaseAuth.updateUser(uid, { disabled });
    await firestore.collection('users').doc(uid).update({
      disabled,
      updatedAt: firestore.Timestamp.now(),
    });

    return sendSuccess(res, { message: `User ${disabled ? 'disabled' : 'enabled'}` });
  })
);

// Delete user
router.delete('/users/:uid',
  validateParams({ uid: { required: true } }),
  asyncHandler(async (req, res) => {
    const { uid } = req.params;

    await firebaseAuth.deleteUser(uid);
    await firestore.collection('users').doc(uid).delete();
    await firestore.collection('profiles').doc(uid).delete();

    return sendSuccess(res, { message: 'User deleted' });
  })
);

// ============ SYSTEM ANALYTICS ============

// Get system statistics
router.get('/analytics/stats', asyncHandler(async (req, res) => {
  const [usersCount, profilesCount, connectionsCount, matchesCount] = await Promise.all([
    firestore.collection('users').count().get(),
    firestore.collection('profiles').count().get(),
    firestore.collection('connections').count().get(),
    firestore.collection('matches').count().get(),
  ]);

  const totalUsers = usersCount.data().count;
  const totalProfiles = profilesCount.data().count;
  const totalConnections = connectionsCount.data().count;
  const totalMatches = matchesCount.data().count;

  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const newUsersSnap = await firestore
    .collection('users')
    .where('createdAt', '>=', sevenDaysAgo)
    .count()
    .get();
  const newUsersThisWeek = newUsersSnap.data().count;

  return sendSuccess(res, {
    stats: {
      totalUsers,
      totalProfiles,
      totalConnections,
      totalMatches,
      newUsersThisWeek,
      profileCompletionRate: totalProfiles > 0 ? Math.round((totalProfiles / totalUsers) * 100) : 0,
    },
  });
}));

// Get system health
router.get('/analytics/health', asyncHandler(async (req, res) => {
  const memUsage = process.memoryUsage();
  const health = {
    status: 'healthy',
    services: {
      firestore: 'up',
      firebase_auth: 'up',
    },
    uptime: process.uptime(),
    memory: {
      used: Math.round(memUsage.heapUsed / 1024 / 1024) + ' MB',
      total: Math.round(memUsage.heapTotal / 1024 / 1024) + ' MB',
    },
  };

  return sendSuccess(res, health);
}));

// ============ CONTENT MANAGEMENT ============

// Get all content/posts
router.get('/content',
  validateQuery({
    page: { type: 'number', min: 1 },
    limit: { type: 'number', min: 1, max: 100 },
  }),
  asyncHandler(async (req, res) => {
    const { page = 1, limit = 20 } = req.query;
    const pageNum = Number(page);
    const pageSize = Number(limit);
    const offset = (pageNum - 1) * pageSize;

    const [contentCount, snap] = await Promise.all([
      firestore.collection('posts').count().get(),
      firestore.collection('posts').orderBy('createdAt', 'desc').limit(pageSize).offset(offset).get(),
    ]);

    const total = contentCount.data().count;
    const content = snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));

    return sendSuccess(res, {
      content,
      pagination: { page: pageNum, limit: pageSize, total, pages: Math.ceil(total / pageSize) },
    });
  })
);

// Moderate/approve content
router.patch('/content/:postId/moderate',
  validateParams({ postId: { required: true } }),
  validateBody({
    approved: { required: true, type: 'boolean' },
  }),
  asyncHandler(async (req, res) => {
    const { postId } = req.params;
    const { approved } = req.body;

    await firestore.collection('posts').doc(postId).update({
      approved,
      moderatedAt: new Date().toISOString(),
      moderatedBy: req.user.uid,
    });

    return sendSuccess(res, { message: `Content ${approved ? 'approved' : 'rejected'}` });
  })
);

// Delete content
router.delete('/content/:postId',
  validateParams({ postId: { required: true } }),
  asyncHandler(async (req, res) => {
    const { postId } = req.params;
    await firestore.collection('posts').doc(postId).delete();
    return sendSuccess(res, { message: 'Content deleted' });
  })
);

// ============ ADMIN SETTINGS ============

// Get system settings
router.get('/settings', asyncHandler(async (req, res) => {
  const settingsDoc = await firestore.collection('admin').doc('settings').get();

  const settings = settingsDoc.exists
    ? settingsDoc.data()
    : {
        maintenanceMode: false,
        signupEnabled: true,
        matchingEnabled: true,
        connectionsEnabled: true,
      };

  return sendSuccess(res, settings);
}));

// Update system settings
router.patch('/settings',
  validateBody({
    maintenanceMode: { type: 'boolean' },
    signupEnabled: { type: 'boolean' },
    matchingEnabled: { type: 'boolean' },
    connectionsEnabled: { type: 'boolean' },
  }),
  asyncHandler(async (req, res) => {
    const settings = req.body;

    await firestore.collection('admin').doc('settings').set(
      {
        ...settings,
        updatedAt: new Date().toISOString(),
        updatedBy: req.user.uid,
      },
      { merge: true }
    );

    return sendSuccess(res, { settings });
  })
);

// ============ GEOFENCE SETTINGS ============

// Get geofence settings
router.get('/geofence-settings', asyncHandler(async (req, res) => {
  const geofenceDoc = await firestore.collection('admin').doc('geofence').get();

  // Default values (fallback to env vars if not set)
  const defaultSettings = {
    enabled: true,
    centerLat: Number(process.env.GEOFENCE_CENTER_LAT) || 51.505,
    centerLng: Number(process.env.GEOFENCE_CENTER_LNG) || 0.05,
    radiusMeters: Number(process.env.GEOFENCE_RADIUS_M) || 1000,
  };

  const settings = geofenceDoc.exists
    ? { ...defaultSettings, ...geofenceDoc.data() }
    : defaultSettings;

  return sendSuccess(res, settings);
}));

// Update geofence settings
router.patch('/geofence-settings',
  validateBody({
    enabled: { type: 'boolean' },
    centerLat: { type: 'number', min: -90, max: 90 },
    centerLng: { type: 'number', min: -180, max: 180 },
    radiusMeters: { type: 'number', min: 10 },
  }),
  asyncHandler(async (req, res) => {
    const settings = req.body;

    await firestore.collection('admin').doc('geofence').set(
      {
        ...settings,
        updatedAt: new Date().toISOString(),
        updatedBy: req.user.uid,
      },
      { merge: true }
    );

    return sendSuccess(res, { settings });
  })
);

export default router;
