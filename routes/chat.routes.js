// Chat and messaging routes
import express from 'express';
import { firestore } from '../config/firebaseAdmin.js';
import { FieldValue } from 'firebase-admin/firestore';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler, sendSuccess, sendError } from '../middleware/errorHandler.js';
import { validateBody, validateQuery, validateParams } from '../middleware/validation.js';
import { getUserProfile } from '../lib/user-helpers.js';
import { canAccessConversation, getParticipantsForConversation } from '../services/chatService.js';

const router = express.Router();
const conversationsRef = firestore.collection('conversations');
const messagesRef = firestore.collection('messages');
const groupsRef = firestore.collection('groups');
const connectionsRef = firestore.collection('connections');

const CONVERSATION_TYPE = { COMMUNITY: 'community', PRIVATE: 'private' };
const CONNECTION_STATUS = { ACCEPTED: 'accepted' };

// Build stable ID for 1:1 conversation from sorted participant IDs
const buildPrivateConvId = (userIds) => userIds.slice().sort().join('_');

// Get conversation display name
const getConversationName = async (conversation, currentUserId) => {
  if (conversation.type === CONVERSATION_TYPE.COMMUNITY && conversation.communityId) {
    const groupDoc = await groupsRef.doc(conversation.communityId).get();
    if (groupDoc.exists) return groupDoc.data().title || 'Community';
  }
  const otherIds = (conversation.participantIds || []).filter((id) => id !== currentUserId);
  if (otherIds.length === 0) return 'Chat';
  const names = await Promise.all(
    otherIds.map(async (uid) => {
      const p = await getUserProfile(uid);
      return p?.displayName || p?.name || uid.slice(0, 8);
    })
  );
  return names.join(', ');
};

/**
 * GET /api/chat/conversations
 * List conversations for the authenticated user (community + private)
 */
router.get(
  '/conversations',
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

    // 1. Private: conversations where participantIds contains userId
    const privateSnap = await conversationsRef
      .where('type', '==', CONVERSATION_TYPE.PRIVATE)
      .where('participantIds', 'array-contains', userId)
      .orderBy('lastMessageAt', 'desc')
      .get();

    // 2. Community: get user's joined groups, then conversations for those groups
    const groupsSnap = await groupsRef
      .where('members', 'array-contains', userId)
      .where('status', '==', 'approved')
      .get();
    const groupIds = groupsSnap.docs.map((d) => d.id);

    const communityConvs = [];
    if (groupIds.length > 0) {
      // Firestore 'in' limit is 10, batch if needed
      for (let i = 0; i < groupIds.length; i += 10) {
        const batch = groupIds.slice(i, i + 10);
        const snap = await conversationsRef
          .where('type', '==', CONVERSATION_TYPE.COMMUNITY)
          .where('communityId', 'in', batch)
          .get();
        communityConvs.push(...snap.docs);
      }
    }

    const allConvs = [
      ...privateSnap.docs.map((d) => ({ id: d.id, ...d.data() })),
      ...communityConvs.map((d) => ({ id: d.id, ...d.data() })),
    ];

    // Sort by lastMessageAt desc, handle nulls
    allConvs.sort((a, b) => {
      const aTime = a.lastMessageAt || a.createdAt || '';
      const bTime = b.lastMessageAt || b.createdAt || '';
      return bTime.localeCompare(aTime);
    });

    const paginated = allConvs.slice(offsetNum, offsetNum + limitNum);

    // Enrich with display names and unreadCount (from participantReads subcollection)
    const enriched = await Promise.all(
      paginated.map(async (c) => {
        const name = await getConversationName(c, userId);
        const readDoc = await conversationsRef.doc(c.id).collection('participantReads').doc(userId).get();
        const unreadCount = readDoc.exists ? (readDoc.data().unreadCount ?? 0) : 0;
        return { ...c, name, unreadCount };
      })
    );

    return sendSuccess(res, {
      conversations: enriched,
      total: allConvs.length,
      limit: limitNum,
      offset: offsetNum,
    });
  })
);

/**
 * POST /api/chat/conversations
 * Create new 1:1 or group conversation
 * Body: { type: 'private', participantIds: string[] } or { type: 'community', communityId: string }
 */
router.post(
  '/conversations',
  requireAuth,
  validateBody({
    type: {
      type: 'string',
      required: true,
      validator: (v) =>
        [CONVERSATION_TYPE.PRIVATE, CONVERSATION_TYPE.COMMUNITY].includes(v) ||
        'Type must be "private" or "community"',
    },
    participantIds: { type: 'array', required: false },
    communityId: { type: 'string', required: false },
  }),
  asyncHandler(async (req, res) => {
    const userId = req.user.uid;
    const { type, participantIds = [], communityId } = req.body;

    if (type === CONVERSATION_TYPE.COMMUNITY) {
      if (!communityId) return sendError(res, 400, 'communityId is required for community conversations');
      const groupDoc = await groupsRef.doc(communityId).get();
      if (!groupDoc.exists) return sendError(res, 404, 'Community not found');
      const group = groupDoc.data();
      if (!(group.members || []).includes(userId)) {
        return sendError(res, 403, 'You must be a member of this community to access its chat');
      }
      // Check if conversation already exists for this community
      const existingSnap = await conversationsRef
        .where('type', '==', CONVERSATION_TYPE.COMMUNITY)
        .where('communityId', '==', communityId)
        .limit(1)
        .get();
      if (!existingSnap.empty) {
        const existing = { id: existingSnap.docs[0].id, ...existingSnap.docs[0].data() };
        const name = await getConversationName(existing, userId);
        return sendSuccess(res, { conversation: { ...existing, name } }, 200);
      }
      const now = new Date().toISOString();
      const convData = {
        type: CONVERSATION_TYPE.COMMUNITY,
        communityId,
        participantIds: [], // community members are resolved via group
        name: group.title || 'Community',
        lastMessage: null,
        lastMessageAt: now,
        createdAt: now,
        updatedAt: now,
      };
      const docRef = await conversationsRef.add(convData);
      return sendSuccess(res, { conversation: { id: docRef.id, ...convData } }, 201);
    }

    // Private conversation
    const ids = [...new Set([userId, ...participantIds])].filter(Boolean);
    if (ids.length < 2) return sendError(res, 400, 'At least one other participant is required');

    // Verify all participants are accepted connections (for 1:1 or small group)
    for (const otherId of ids) {
      if (otherId === userId) continue;
      const connectionId = [userId, otherId].sort().join('_');
      const connDoc = await connectionsRef.doc(connectionId).get();
      if (!connDoc.exists || connDoc.data().status !== CONNECTION_STATUS.ACCEPTED) {
        return sendError(res, 403, `You must be connected with all participants before messaging`);
      }
    }

    const convId = buildPrivateConvId(ids);
    const existingDoc = await conversationsRef.doc(convId).get();
    if (existingDoc.exists) {
      const existing = { id: existingDoc.id, ...existingDoc.data() };
      const name = await getConversationName(existing, userId);
      return sendSuccess(res, { conversation: { ...existing, name } }, 200);
    }

    const now = new Date().toISOString();
    const convData = {
      id: convId,
      type: CONVERSATION_TYPE.PRIVATE,
      communityId: null,
      participantIds: ids,
      lastMessage: null,
      lastMessageAt: now,
      createdAt: now,
      updatedAt: now,
    };
    await conversationsRef.doc(convId).set(convData);
    const name = await getConversationName(convData, userId);
    return sendSuccess(res, { conversation: { ...convData, name } }, 201);
  })
);

/**
 * GET /api/chat/conversations/:id
 * Get conversation metadata (if user is participant)
 */
router.get(
  '/conversations/:id',
  requireAuth,
  validateParams({ id: { required: true } }),
  asyncHandler(async (req, res) => {
    const userId = req.user.uid;
    const { id } = req.params;
    const doc = await conversationsRef.doc(id).get();
    if (!doc.exists) return sendError(res, 404, 'Conversation not found');
    const conversation = { id: doc.id, ...doc.data() };
    const allowed = await canAccessConversation(conversation, userId);
    if (!allowed) return sendError(res, 403, 'Access denied');
    const name = await getConversationName(conversation, userId);
    const readDoc = await conversationsRef.doc(id).collection('participantReads').doc(userId).get();
    const unreadCount = readDoc.exists ? (readDoc.data().unreadCount ?? 0) : 0;
    return sendSuccess(res, { conversation: { ...conversation, name, unreadCount } });
  })
);

/**
 * GET /api/chat/conversations/:id/messages
 * Fetch paginated message history
 */
router.get(
  '/conversations/:id/messages',
  requireAuth,
  validateParams({ id: { required: true } }),
  validateQuery({
    limit: { type: 'number', min: 1, max: 100 },
    before: { type: 'string', required: false },
  }),
  asyncHandler(async (req, res) => {
    const userId = req.user.uid;
    const { id } = req.params;
    const { limit = 50, before } = req.query;
    const limitNum = Number(limit);

    const convDoc = await conversationsRef.doc(id).get();
    if (!convDoc.exists) return sendError(res, 404, 'Conversation not found');
    const conversation = { id: convDoc.id, ...convDoc.data() };
    const allowed = await canAccessConversation(conversation, userId);
    if (!allowed) return sendError(res, 403, 'Access denied');

    let query = messagesRef
      .where('conversationId', '==', id)
      .orderBy('createdAt', 'desc')
      .limit(limitNum);

    if (before) {
      const beforeDoc = await messagesRef.doc(before).get();
      if (beforeDoc.exists) {
        query = query.startAfter(beforeDoc);
      }
    }

    const snapshot = await query.get();
    const rawMessages = snapshot.docs.map((d) => ({ id: d.id, ...d.data() })).reverse();
    // Enrich with sender display names
    const senderIds = [...new Set(rawMessages.map((m) => m.senderId).filter(Boolean))];
    const senderNames = {};
    await Promise.all(
      senderIds.map(async (uid) => {
        const p = await getUserProfile(uid);
        senderNames[uid] = p?.displayName || p?.name || uid.slice(0, 8);
      })
    );
    const messages = rawMessages.map((m) => ({
      ...m,
      senderName: senderNames[m.senderId] || 'Unknown',
    }));
    return sendSuccess(res, { messages });
  })
);

/**
 * POST /api/chat/conversations/:id/messages
 * Send a new message
 */
router.post(
  '/conversations/:id/messages',
  requireAuth,
  validateParams({ id: { required: true } }),
  validateBody({
    content: { type: 'string', required: true, maxLength: 5000 },
  }),
  asyncHandler(async (req, res) => {
    const userId = req.user.uid;
    const { id } = req.params;
    const { content } = req.body;
    const trimmed = (content || '').trim();
    if (!trimmed) return sendError(res, 400, 'Message content is required');

    const convDoc = await conversationsRef.doc(id).get();
    if (!convDoc.exists) return sendError(res, 404, 'Conversation not found');
    const conversation = { id: convDoc.id, ...convDoc.data() };
    const allowed = await canAccessConversation(conversation, userId);
    if (!allowed) return sendError(res, 403, 'Access denied');

    const now = new Date().toISOString();
    const messageData = {
      conversationId: id,
      senderId: userId,
      content: trimmed,
      createdAt: now,
    };
    const messageRef = await messagesRef.add(messageData);
    const message = { id: messageRef.id, ...messageData };

    // Update conversation lastMessage
    await conversationsRef.doc(id).update({
      lastMessage: trimmed.slice(0, 100),
      lastMessageAt: now,
      updatedAt: now,
    });

    // Increment unread for all participants except sender
    const participants = await getParticipantsForConversation(conversation);
    const participantReadsRef = conversationsRef.doc(id).collection('participantReads');
    await Promise.all(
      participants
        .filter((uid) => uid !== userId)
        .map((uid) =>
          participantReadsRef.doc(uid).set(
            { unreadCount: FieldValue.increment(1) },
            { merge: true }
          )
        )
    );

    // Emit via Socket.io for real-time delivery
    const io = req.app.get('io');
    if (io) {
      const room = `conv:${id}`;
      const senderProfile = await getUserProfile(userId);
      io.to(room).emit('chat:new-message', {
        ...message,
        senderName: senderProfile?.displayName || senderProfile?.name || 'Unknown',
      });
    }

    return sendSuccess(res, { message }, 201);
  })
);

/**
 * POST /api/chat/conversations/:id/read (optional)
 * Mark conversation as read for current user
 */
router.post(
  '/conversations/:id/read',
  requireAuth,
  validateParams({ id: { required: true } }),
  asyncHandler(async (req, res) => {
    const userId = req.user.uid;
    const { id } = req.params;
    const convDoc = await conversationsRef.doc(id).get();
    if (!convDoc.exists) return sendError(res, 404, 'Conversation not found');
    const conversation = { id: convDoc.id, ...convDoc.data() };
    const allowed = await canAccessConversation(conversation, userId);
    if (!allowed) return sendError(res, 403, 'Access denied');

    // Reset unread for this user and conversation
    await conversationsRef.doc(id).collection('participantReads').doc(userId).set(
      { unreadCount: 0 },
      { merge: true }
    );
    return sendSuccess(res, { read: true });
  })
);

/**
 * GET /api/chat/conversations/by-community/:communityId
 * Get or create community conversation (for "Open community chat" flow)
 */
router.get(
  '/conversations/by-community/:communityId',
  requireAuth,
  validateParams({ communityId: { required: true } }),
  asyncHandler(async (req, res) => {
    const userId = req.user.uid;
    const { communityId } = req.params;
    const groupDoc = await groupsRef.doc(communityId).get();
    if (!groupDoc.exists) return sendError(res, 404, 'Community not found');
    const group = groupDoc.data();
    if (!(group.members || []).includes(userId)) {
      return sendError(res, 403, 'You must be a member of this community to access its chat');
    }
    const snap = await conversationsRef
      .where('type', '==', CONVERSATION_TYPE.COMMUNITY)
      .where('communityId', '==', communityId)
      .limit(1)
      .get();
    let conversation;
    if (snap.empty) {
      const now = new Date().toISOString();
      const convData = {
        type: CONVERSATION_TYPE.COMMUNITY,
        communityId,
        participantIds: [],
        name: group.title || 'Community',
        lastMessage: null,
        lastMessageAt: now,
        createdAt: now,
        updatedAt: now,
      };
      const docRef = await conversationsRef.add(convData);
      conversation = { id: docRef.id, ...convData };
    } else {
      const doc = snap.docs[0];
      conversation = { id: doc.id, ...doc.data() };
    }
    const name = await getConversationName(conversation, userId);
    const readDoc = await conversationsRef.doc(conversation.id).collection('participantReads').doc(userId).get();
    const unreadCount = readDoc.exists ? (readDoc.data().unreadCount ?? 0) : 0;
    return sendSuccess(res, { conversation: { ...conversation, name, unreadCount } });
  })
);

/**
 * GET /api/chat/conversations/by-user/:userId
 * Get or create 1:1 conversation with a connection
 */
router.get(
  '/conversations/by-user/:userId',
  requireAuth,
  validateParams({ userId: { required: true } }),
  asyncHandler(async (req, res) => {
    const currentUserId = req.user.uid;
    const otherUserId = req.params.userId;
    if (otherUserId === currentUserId) return sendError(res, 400, 'Cannot message yourself');

    const connectionId = [currentUserId, otherUserId].sort().join('_');
    const connDoc = await connectionsRef.doc(connectionId).get();
    if (!connDoc.exists || connDoc.data().status !== CONNECTION_STATUS.ACCEPTED) {
      return sendError(res, 403, 'You must be connected to message this user');
    }

    const convId = buildPrivateConvId([currentUserId, otherUserId]);
    const convDoc = await conversationsRef.doc(convId).get();
    let conversation;
    if (!convDoc.exists) {
      const now = new Date().toISOString();
      const convData = {
        id: convId,
        type: CONVERSATION_TYPE.PRIVATE,
        communityId: null,
        participantIds: [currentUserId, otherUserId],
        lastMessage: null,
        lastMessageAt: now,
        createdAt: now,
        updatedAt: now,
      };
      await conversationsRef.doc(convId).set(convData);
      conversation = convData;
    } else {
      conversation = { id: convDoc.id, ...convDoc.data() };
    }
    const name = await getConversationName(conversation, currentUserId);
    const readDoc = await conversationsRef.doc(conversation.id).collection('participantReads').doc(currentUserId).get();
    const unreadCount = readDoc.exists ? (readDoc.data().unreadCount ?? 0) : 0;
    return sendSuccess(res, { conversation: { ...conversation, name, unreadCount } });
  })
);

export default router;
