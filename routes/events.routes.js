// Event creation, listing, and RSVP routes
import express from 'express';
import { firestore } from '../config/firebaseAdmin.js';
import { FieldValue } from 'firebase-admin/firestore';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { asyncHandler, sendSuccess, sendError } from '../middleware/errorHandler.js';
import { validateBody, validateQuery, validateParams } from '../middleware/validation.js';
// AI service client used for event/community recommendations.
import { runAiGraph } from '../services/aiServiceClient.js';

const router = express.Router();
const eventsRef = firestore.collection('events');
const profilesRef = firestore.collection('profiles');
const usersRef = firestore.collection('users');

/** Emit socket event to a specific user's sockets (JWT-derived userId only) */
const emitToUser = (io, userSockets, userId, eventName, payload) => {
  const sids = userSockets?.get(userId);
  if (sids && sids.size > 0) {
    for (const sid of sids) {
      io.to(sid).emit(eventName, payload);
    }
  }
};

/** Emit to all connected users (for event broadcasts) */
const emitToAllUsers = (io, eventName, payload) => {
  if (!io?.userSockets) return;
  for (const userId of io.userSockets.keys()) {
    emitToUser(io, io.userSockets, userId, eventName, payload);
  }
};

const EVENT_STATUS = {
  PENDING: 'pending',
  APPROVED: 'approved',
  REJECTED: 'rejected',
};

// Normalize topics: lowercase, trim, filter empty
const normalizeTopics = (topics) => {
  if (!Array.isArray(topics)) return [];
  return topics
    .map((t) => (typeof t === 'string' ? t.trim().toLowerCase() : ''))
    .filter(Boolean);
};

// AI-powered events/groups recommendations (student-facing) → graph: events_communities.
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

      // Normalize response for the frontend.
      return sendSuccess(res, {
        events: aiResponse?.data?.events || [],
        groups: aiResponse?.data?.groups || [],
        meta: aiResponse?.data?.meta || {},
      });
    } catch (err) {
      console.error('AI events/groups error:', err);
      return sendError(res, 502, 'AI events/groups service unavailable', err?.payload || err?.message);
    }
  })
);

// Create an event (students create with status=pending, admins create with status=approved)
router.post('/',
  requireAuth,
  validateBody({
    title: { type: 'string', required: true, maxLength: 200 },
    aim: { type: 'string', required: true, maxLength: 500 },
    topics: { type: 'array', required: true, minItems: 1 },
    startTime: { type: 'string', required: true },
    endTime: { type: 'string', required: true },
    location: { type: 'string', required: true, maxLength: 200 },
  }),
  asyncHandler(async (req, res) => {
    const { title, aim, topics, startTime, endTime, location } = req.body;
    const userId = req.user.uid;
    const userRole = req.user.role || 'user';
    const isAdmin = userRole === 'admin';

    // Validate dates
    const startDate = new Date(startTime);
    const endDate = new Date(endTime);

    if (isNaN(startDate.getTime())) {
      return sendError(res, 'Invalid startTime', 400);
    }
    if (isNaN(endDate.getTime())) {
      return sendError(res, 'Invalid endTime', 400);
    }
    if (endDate <= startDate) {
      return sendError(res, 'endTime must be after startTime', 400);
    }

    // Normalize topics
    const normalizedTopics = normalizeTopics(topics);
    if (normalizedTopics.length === 0) {
      return sendError(res, 'At least one topic is required', 400);
    }

    const now = new Date().toISOString();
    const eventData = {
      title: title.trim(),
      aim: aim.trim(),
      topics: normalizedTopics,
      startTime: startDate.toISOString(),
      endTime: endDate.toISOString(),
      location: location.trim(),
      createdBy: userId,
      createdByRole: isAdmin ? 'admin' : 'student',
      status: isAdmin ? EVENT_STATUS.APPROVED : EVENT_STATUS.PENDING,
      attendees: [],
      attendeesCount: 0,
      createdAt: now,
      updatedAt: now,
    };

    const docRef = await eventsRef.add(eventData);
    const eventId = docRef.id;

    // Emit real-time notification to all connected users (JWT-derived identities only)
    const io = req.app.get('io');
    if (io?.userSockets) {
      const [profileSnap, userSnap] = await Promise.all([
        profilesRef.doc(userId).get(),
        usersRef.doc(userId).get(),
      ]);
      const profileData = profileSnap?.exists ? profileSnap.data() : {};
      const userData = userSnap?.exists ? userSnap.data() : {};
      const createdByName = profileData.name || profileData.displayName || userData.name || userData.email || 'Unknown';

      const payload = {
        eventId,
        title: eventData.title,
        communityId: eventData.communityId || null,
        startsAt: eventData.startTime,
        createdByName,
      };
      emitToAllUsers(io, 'event:created', payload);
    }

    return sendSuccess(res, { id: eventId, ...eventData }, 201);
  })
);

// List approved events (for students)
router.get('/',
  requireAuth,
  validateQuery({
    limit: { type: 'number', min: 1, max: 100 },
    offset: { type: 'number', min: 0 },
  }),
  asyncHandler(async (req, res) => {
    const { limit = 50, offset = 0 } = req.query;
    const limitNum = Number(limit);
    const offsetNum = Number(offset);

    const snapshot = await eventsRef
      .where('status', '==', EVENT_STATUS.APPROVED)
      .orderBy('startTime', 'asc')
      .get();

    const allEvents = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    
    // Filter out past events for better UX (optional - can be removed if you want to show past events)
    const now = new Date();
    const upcomingEvents = allEvents.filter((event) => new Date(event.endTime) >= now);

    const paginatedEvents = upcomingEvents.slice(offsetNum, offsetNum + limitNum);

    return sendSuccess(res, {
      events: paginatedEvents,
      total: upcomingEvents.length,
      limit: limitNum,
      offset: offsetNum,
    });
  })
);

// Get a single event by ID
router.get('/:id',
  requireAuth,
  validateParams({ id: { required: true } }),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const doc = await eventsRef.doc(id).get();

    if (!doc.exists) {
      return sendError(res, 'Event not found', 404);
    }

    const data = doc.data();
    
    // Students can only see approved events
    const userRole = req.user.role || 'user';
    if (userRole !== 'admin' && data.status !== EVENT_STATUS.APPROVED) {
      return sendError(res, 'Event not found', 404);
    }

    return sendSuccess(res, { id: doc.id, ...data });
  })
);

// Admin routes - list pending events
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

    const snapshot = await eventsRef
      .where('status', '==', EVENT_STATUS.PENDING)
      .orderBy('createdAt', 'desc')
      .get();

    const allEvents = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    const paginatedEvents = allEvents.slice(offsetNum, offsetNum + limitNum);

    return sendSuccess(res, {
      events: paginatedEvents,
      total: allEvents.length,
      limit: limitNum,
      offset: offsetNum,
    });
  })
);

// Admin routes - list all events by status
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

    let query = eventsRef.orderBy('createdAt', 'desc');
    if (status) {
      query = query.where('status', '==', status);
    }

    const snapshot = await query.get();
    const allEvents = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    const paginatedEvents = allEvents.slice(offsetNum, offsetNum + limitNum);

    return sendSuccess(res, {
      events: paginatedEvents,
      total: allEvents.length,
      limit: limitNum,
      offset: offsetNum,
    });
  })
);

// Admin: Approve an event
router.patch('/:id/approve',
  requireAuth,
  requireAdmin,
  validateParams({ id: { required: true } }),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const docRef = eventsRef.doc(id);
    const doc = await docRef.get();

    if (!doc.exists) {
      return sendError(res, 'Event not found', 404);
    }

    const data = doc.data();
    await docRef.update({
      status: EVENT_STATUS.APPROVED,
      updatedAt: new Date().toISOString(),
    });

    const io = req.app.get('io');
    if (io?.userSockets) {
      const payload = {
        eventId: id,
        title: data.title,
        communityId: data.communityId || null,
        startsAt: data.startTime,
        updatedFields: { status: EVENT_STATUS.APPROVED },
      };
      emitToAllUsers(io, 'event:updated', payload);
    }

    return sendSuccess(res, { id, status: EVENT_STATUS.APPROVED });
  })
);

// Admin: Reject an event
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
    const docRef = eventsRef.doc(id);
    const doc = await docRef.get();

    if (!doc.exists) {
      return sendError(res, 'Event not found', 404);
    }

    const updateData = {
      status: EVENT_STATUS.REJECTED,
      updatedAt: new Date().toISOString(),
    };

    if (reason) {
      updateData.rejectionReason = reason.trim();
    }

    const data = doc.data();
    await docRef.update(updateData);

    const io = req.app.get('io');
    if (io?.userSockets) {
      const payload = {
        eventId: id,
        title: data.title,
        communityId: data.communityId || null,
        startsAt: data.startTime,
        updatedFields: { status: EVENT_STATUS.REJECTED, ...(updateData.rejectionReason && { rejectionReason: updateData.rejectionReason }) },
      };
      emitToAllUsers(io, 'event:updated', payload);
    }

    return sendSuccess(res, { id, status: EVENT_STATUS.REJECTED });
  })
);

// RSVP to an event
router.post('/:id/rsvp',
  requireAuth,
  validateParams({ id: { required: true } }),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const userId = req.user.uid;
    const docRef = eventsRef.doc(id);
    const doc = await docRef.get();

    if (!doc.exists) {
      return sendError(res, 'Event not found', 404);
    }

    const data = doc.data();
    if (data.status !== EVENT_STATUS.APPROVED) {
      return sendError(res, 'Only approved events can be RSVP\'d to', 400);
    }

    const attendees = data.attendees || [];
    if (attendees.includes(userId)) {
      return sendSuccess(res, { id, message: 'Already RSVP\'d', isRSVPd: true });
    }

    await docRef.update({
      attendees: FieldValue.arrayUnion(userId),
      attendeesCount: FieldValue.increment(1),
      updatedAt: new Date().toISOString(),
    });

    const io = req.app.get('io');
    if (io?.userSockets) {
      const payload = {
        eventId: id,
        title: data.title,
        communityId: data.communityId || null,
        startsAt: data.startTime,
        updatedFields: { attendees: 'added' },
      };
      emitToAllUsers(io, 'event:updated', payload);
    }

    return sendSuccess(res, { id, message: 'Successfully RSVP\'d to event', isRSVPd: true });
  })
);

// Withdraw RSVP from an event
router.post('/:id/withdraw',
  requireAuth,
  validateParams({ id: { required: true } }),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const userId = req.user.uid;
    const docRef = eventsRef.doc(id);
    const doc = await docRef.get();

    if (!doc.exists) {
      return sendError(res, 'Event not found', 404);
    }

    const data = doc.data();
    const attendees = data.attendees || [];
    if (!attendees.includes(userId)) {
      return sendSuccess(res, { id, message: 'Not RSVP\'d', isRSVPd: false });
    }

    await docRef.update({
      attendees: FieldValue.arrayRemove(userId),
      attendeesCount: FieldValue.increment(-1),
      updatedAt: new Date().toISOString(),
    });

    const io = req.app.get('io');
    if (io?.userSockets) {
      const payload = {
        eventId: id,
        title: data.title,
        communityId: data.communityId || null,
        startsAt: data.startTime,
        updatedFields: { attendees: 'removed' },
      };
      emitToAllUsers(io, 'event:updated', payload);
    }

    return sendSuccess(res, { id, message: 'Successfully withdrew RSVP', isRSVPd: false });
  })
);

// Get events the user has RSVP'd to (My Events)
router.get('/my/rsvpd',
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

    const snapshot = await eventsRef
      .where('attendees', 'array-contains', userId)
      .where('status', '==', EVENT_STATUS.APPROVED)
      .orderBy('startTime', 'asc')
      .get();

    const events = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    const paginated = events.slice(offsetNum, offsetNum + limitNum);

    return sendSuccess(res, {
      events: paginated,
      total: events.length,
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
      return sendSuccess(res, { events: [] });
    }

    const profile = profileSnap.data();
    const userInterests = (profile.interests || []).map(i => (i || '').toLowerCase().trim()).filter(Boolean);

    // Get all approved upcoming events
    const now = new Date();
    const snapshot = await eventsRef
      .where('status', '==', EVENT_STATUS.APPROVED)
      .get();

    const allEvents = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    const upcomingEvents = allEvents.filter(e => new Date(e.endTime) >= now);

    // Score events based on topic overlap
    const scored = upcomingEvents
      .filter(e => !(e.attendees || []).includes(userId)) // Exclude already RSVP'd
      .map(event => {
        const eventTopics = (event.topics || []).map(t => (t || '').toLowerCase().trim());
        const topicOverlap = userInterests.filter(i => eventTopics.includes(i)).length;
        const score = topicOverlap * 10; // 10 points per matching topic
        
        return { ...event, score, topicOverlap };
      })
      .filter(e => e.score > 0) // Only return events with some overlap
      .sort((a, b) => b.score - a.score)
      .slice(0, limitNum);

    return sendSuccess(res, { events: scored });
  })
);

export default router;
