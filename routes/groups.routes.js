// Group community management routes
import express from 'express';
import { firestore } from '../config/firebaseAdmin.js';
import { FieldValue } from 'firebase-admin/firestore';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { asyncHandler, sendSuccess, sendError } from '../middleware/errorHandler.js';
import { validateBody, validateQuery, validateParams } from '../middleware/validation.js';
// AI service client used for community recommendations.
import { runAiGraph } from '../services/aiServiceClient.js';

const router = express.Router();
const groupsRef = firestore.collection('groups');
const profilesRef = firestore.collection('profiles');

const GROUP_STATUS = {
  PENDING: 'pending',
  APPROVED: 'approved',
  REJECTED: 'rejected',
};

const GROUP_TYPE = {
  COURSE: 'course',
  INTEREST: 'interest',
  SUPPORT: 'support',
  OFFICIAL: 'official',
};

// Normalize topics: lowercase, trim, filter empty
const normalizeTopics = (topics) => {
  if (!Array.isArray(topics)) return [];
  return topics
    .map((t) => (typeof t === 'string' ? t.trim().toLowerCase() : ''))
    .filter(Boolean);
};

// AI-powered group recommendations (student-facing) → graph: events_communities.
router.post('/recommendations',
  requireAuth,
  validateBody({
    userId: { type: 'string', required: false },
    tenantId: { type: 'string', required: false },
    interests: { type: 'array', required: false },
    location: { type: 'object', required: false },
    limit: { type: 'number', required: false, min: 1, max: 50 },
  }),
  asyncHandler(async (req, res) => {
    // Build AI input using body with fallbacks from authenticated user.
    const { userId, tenantId, interests, location, limit } = req.body || {};
    const resolvedUserId = userId || req.user.uid;
    const resolvedTenantId = tenantId || req.user?.data?.tenantId || null;

    try {
      // AI-driven events/communities call.
      const aiResponse = await runAiGraph({
        graph: 'events_communities',
        input: {
          user_id: resolvedUserId,
          tenant_id: resolvedTenantId,
          interests: interests || [],
          location: location || null,
          limit: limit || null,
        },
      });

      // Normalize response for the frontend (groups focus).
      return sendSuccess(res, {
        groups: aiResponse?.data?.groups || [],
        events: aiResponse?.data?.events || [],
        meta: aiResponse?.data?.meta || {},
      });
    } catch (err) {
      console.error('AI groups/events error:', err);
      return sendError(res, 502, 'AI groups/events service unavailable', err?.payload || err?.message);
    }
  })
);

// Create a group (students create with status=pending, admins create with status=approved)
router.post('/',
  requireAuth,
  validateBody({
    title: { type: 'string', required: true, maxLength: 200 },
    aim: { type: 'string', required: true, maxLength: 500 },
    topics: { type: 'array', required: true, minItems: 1 },
    type: { 
      type: 'string', 
      required: true, 
      validator: (v) => ['course', 'interest', 'support', 'official'].includes(v) || 'Type must be one of: course, interest, support, official'
    },
  }),
  asyncHandler(async (req, res) => {
    const { title, aim, topics, type } = req.body;
    const userId = req.user.uid;
    const userRole = req.user.role || 'user';
    const isAdmin = userRole === 'admin';

    // Admins can create official groups, students cannot
    if (type === GROUP_TYPE.OFFICIAL && !isAdmin) {
      return sendError(res, 'Only admins can create official groups', 403);
    }

    // Normalize topics
    const normalizedTopics = normalizeTopics(topics);
    if (normalizedTopics.length === 0) {
      return sendError(res, 'At least one topic is required', 400);
    }

    const now = new Date().toISOString();
    const groupData = {
      title: title.trim(),
      aim: aim.trim(),
      topics: normalizedTopics,
      type,
      createdBy: userId,
      createdByRole: isAdmin ? 'admin' : 'student',
      status: isAdmin ? GROUP_STATUS.APPROVED : GROUP_STATUS.PENDING,
      members: [],
      membersCount: 0,
      createdAt: now,
      updatedAt: now,
    };

    const docRef = await groupsRef.add(groupData);
    
    return sendSuccess(res, { id: docRef.id, ...groupData }, isAdmin ? 201 : 201);
  })
);

// List approved groups (for students)
router.get('/',
  requireAuth,
  validateQuery({
    limit: { type: 'number', min: 1, max: 100 },
    offset: { type: 'number', min: 0 },
    type: { 
      type: 'string', 
      validator: (v) => !v || ['course', 'interest', 'support', 'official'].includes(v) || 'Type must be one of: course, interest, support, official'
    },
  }),
  asyncHandler(async (req, res) => {
    const { limit = 50, offset = 0, type } = req.query;
    const limitNum = Number(limit);
    const offsetNum = Number(offset);
    const userRole = req.user.role || 'user';

    let query = groupsRef.where('status', '==', GROUP_STATUS.APPROVED);

    if (type) {
      query = query.where('type', '==', type);
    }

    const snapshot = await query.orderBy('createdAt', 'desc').get();
    const allGroups = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));

    const paginatedGroups = allGroups.slice(offsetNum, offsetNum + limitNum);

    return sendSuccess(res, {
      groups: paginatedGroups,
      total: allGroups.length,
      limit: limitNum,
      offset: offsetNum,
    });
  })
);

// Get a single group by ID
router.get('/:id',
  requireAuth,
  validateParams({ id: { required: true } }),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const doc = await groupsRef.doc(id).get();

    if (!doc.exists) {
      return sendError(res, 'Group not found', 404);
    }

    const data = doc.data();
    
    // Students can only see approved groups
    const userRole = req.user.role || 'user';
    if (userRole !== 'admin' && data.status !== GROUP_STATUS.APPROVED) {
      return sendError(res, 'Group not found', 404);
    }

    return sendSuccess(res, { id: doc.id, ...data });
  })
);

// Admin routes - list pending groups
router.get('/admin/pending',
  requireAuth,
  requireAdmin,
  validateQuery({
    limit: { type: 'number', min: 1, max: 100 },
    offset: { type: 'number', min: 0 },
  }),
  asyncHandler(async (req, res) => {
    const { limit = 50, offset = 0 } = req.query;
    const limitNum = Number(limit);
    const offsetNum = Number(offset);

    const snapshot = await groupsRef
      .where('status', '==', GROUP_STATUS.PENDING)
      .orderBy('createdAt', 'desc')
      .get();

    const allGroups = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    const paginatedGroups = allGroups.slice(offsetNum, offsetNum + limitNum);

    return sendSuccess(res, {
      groups: paginatedGroups,
      total: allGroups.length,
      limit: limitNum,
      offset: offsetNum,
    });
  })
);

// Admin routes - list all groups by status
router.get('/admin/all',
  requireAuth,
  requireAdmin,
  validateQuery({
    status: { 
      type: 'string', 
      validator: (v) => !v || ['pending', 'approved', 'rejected'].includes(v) || 'Status must be one of: pending, approved, rejected'
    },
    limit: { type: 'number', min: 1, max: 100 },
    offset: { type: 'number', min: 0 },
  }),
  asyncHandler(async (req, res) => {
    const { status, limit = 50, offset = 0 } = req.query;
    const limitNum = Number(limit);
    const offsetNum = Number(offset);

    let query = groupsRef.orderBy('createdAt', 'desc');
    if (status) {
      query = query.where('status', '==', status);
    }

    const snapshot = await query.get();
    const allGroups = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    const paginatedGroups = allGroups.slice(offsetNum, offsetNum + limitNum);

    return sendSuccess(res, {
      groups: paginatedGroups,
      total: allGroups.length,
      limit: limitNum,
      offset: offsetNum,
    });
  })
);

// Admin: Approve a group
router.patch('/:id/approve',
  requireAuth,
  requireAdmin,
  validateParams({ id: { required: true } }),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const docRef = groupsRef.doc(id);
    const doc = await docRef.get();

    if (!doc.exists) {
      return sendError(res, 'Group not found', 404);
    }

    await docRef.update({
      status: GROUP_STATUS.APPROVED,
      updatedAt: new Date().toISOString(),
    });

    return sendSuccess(res, { id, status: GROUP_STATUS.APPROVED });
  })
);

// Admin: Reject a group
router.patch('/:id/reject',
  requireAuth,
  requireAdmin,
  validateParams({ id: { required: true } }),
  validateBody({
    reason: { type: 'string', maxLength: 500 },
  }),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { reason } = req.body || {};
    const docRef = groupsRef.doc(id);
    const doc = await docRef.get();

    if (!doc.exists) {
      return sendError(res, 'Group not found', 404);
    }

    const updateData = {
      status: GROUP_STATUS.REJECTED,
      updatedAt: new Date().toISOString(),
    };

    if (reason) {
      updateData.rejectionReason = reason.trim();
    }

    await docRef.update(updateData);

    return sendSuccess(res, { id, status: GROUP_STATUS.REJECTED });
  })
);

// Join a group
router.post('/:id/join',
  requireAuth,
  validateParams({ id: { required: true } }),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const userId = req.user.uid;
    const docRef = groupsRef.doc(id);
    const doc = await docRef.get();

    if (!doc.exists) {
      return sendError(res, 'Group not found', 404);
    }

    const data = doc.data();
    if (data.status !== GROUP_STATUS.APPROVED) {
      return sendError(res, 'Only approved groups can be joined', 400);
    }

    const members = data.members || [];
    if (members.includes(userId)) {
      return sendSuccess(res, { id, message: 'Already a member', isMember: true });
    }

    await docRef.update({
      members: FieldValue.arrayUnion(userId),
      membersCount: FieldValue.increment(1),
      updatedAt: new Date().toISOString(),
    });

    return sendSuccess(res, { id, message: 'Successfully joined group', isMember: true });
  })
);

// Leave a group
router.post('/:id/leave',
  requireAuth,
  validateParams({ id: { required: true } }),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const userId = req.user.uid;
    const docRef = groupsRef.doc(id);
    const doc = await docRef.get();

    if (!doc.exists) {
      return sendError(res, 'Group not found', 404);
    }

    const data = doc.data();
    const members = data.members || [];
    if (!members.includes(userId)) {
      return sendSuccess(res, { id, message: 'Not a member', isMember: false });
    }

    await docRef.update({
      members: FieldValue.arrayRemove(userId),
      membersCount: FieldValue.increment(-1),
      updatedAt: new Date().toISOString(),
    });

    return sendSuccess(res, { id, message: 'Successfully left group', isMember: false });
  })
);

// Get groups the user has joined (My Communities)
router.get('/my/joined',
  requireAuth,
  validateQuery({
    limit: { type: 'number', min: 1, max: 100 },
    offset: { type: 'number', min: 0 },
  }),
  asyncHandler(async (req, res) => {
    const userId = req.user.uid;
    const { limit = 50, offset = 0 } = req.query;
    const limitNum = Number(limit);
    const offsetNum = Number(offset);

    const snapshot = await groupsRef
      .where('members', 'array-contains', userId)
      .where('status', '==', GROUP_STATUS.APPROVED)
      .orderBy('updatedAt', 'desc')
      .get();

    const groups = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    const paginated = groups.slice(offsetNum, offsetNum + limitNum);

    return sendSuccess(res, {
      groups: paginated,
      total: groups.length,
      limit: limitNum,
      offset: offsetNum,
    });
  })
);

// Legacy local recommendations (non-AI) retained for backward compatibility.
router.get('/recommended',
  requireAuth,
  validateQuery({
    limit: { type: 'number', min: 1, max: 20 },
  }),
  asyncHandler(async (req, res) => {
    const userId = req.user.uid;
    const { limit = 10 } = req.query;
    const limitNum = Number(limit);

    // Get user profile
    const profilesRef = firestore.collection('profiles');
    const profileSnap = await profilesRef.doc(userId).get();
    if (!profileSnap.exists) {
      return sendSuccess(res, { groups: [] });
    }

    const profile = profileSnap.data();
    const userInterests = (profile.interests || []).map(i => (i || '').toLowerCase().trim()).filter(Boolean);
    const userMajor = (profile.major || '').toLowerCase().trim();

    // Get all approved groups
    const snapshot = await groupsRef
      .where('status', '==', GROUP_STATUS.APPROVED)
      .get();

    const allGroups = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));

    // Score groups based on topic overlap and type relevance
    const scored = allGroups
      .filter(g => !(g.members || []).includes(userId)) // Exclude already joined
      .map(group => {
        const groupTopics = (group.topics || []).map(t => (t || '').toLowerCase().trim());
        const topicOverlap = userInterests.filter(i => groupTopics.includes(i)).length;
        const score = topicOverlap * 10; // 10 points per matching topic
        
        return { ...group, score, topicOverlap };
      })
      .filter(g => g.score > 0) // Only return groups with some overlap
      .sort((a, b) => b.score - a.score)
      .slice(0, limitNum);

    return sendSuccess(res, { groups: scored });
  })
);

export default router;
