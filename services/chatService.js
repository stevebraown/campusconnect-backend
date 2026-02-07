/**
 * Chat service - shared logic for conversation access and helpers
 */
import { firestore } from '../config/firebaseAdmin.js';
import { getUserProfile } from '../lib/user-helpers.js';

const conversationsRef = firestore.collection('conversations');
const groupsRef = firestore.collection('groups');

const CONVERSATION_TYPE = { COMMUNITY: 'community', PRIVATE: 'private' };

/**
 * Get participant user IDs for a conversation (for unread increments)
 * @param {Object} conversation - Conversation document
 * @returns {Promise<string[]>}
 */
export const getParticipantsForConversation = async (conversation) => {
  if (conversation.type === CONVERSATION_TYPE.PRIVATE && (conversation.participantIds || []).length > 0) {
    return conversation.participantIds;
  }
  if (conversation.type === CONVERSATION_TYPE.COMMUNITY && conversation.communityId) {
    const groupDoc = await groupsRef.doc(conversation.communityId).get();
    if (!groupDoc.exists) return [];
    const group = groupDoc.data();
    return group.members || [];
  }
  return [];
};

/**
 * Check if user can access a conversation (participant or community member)
 * @param {Object} conversation - Conversation document
 * @param {string} userId - User ID
 * @returns {Promise<boolean>}
 */
export const canAccessConversation = async (conversation, userId) => {
  if (conversation.type === CONVERSATION_TYPE.COMMUNITY) {
    const groupDoc = await groupsRef.doc(conversation.communityId).get();
    if (!groupDoc.exists) return false;
    const group = groupDoc.data();
    return (group.members || []).includes(userId);
  }
  return (conversation.participantIds || []).includes(userId);
};

/**
 * Get conversation by ID (for socket join verification)
 * @param {string} conversationId
 * @returns {Promise<Object|null>}
 */
export const getConversationById = async (conversationId) => {
  const doc = await conversationsRef.doc(conversationId).get();
  if (!doc.exists) return null;
  return { id: doc.id, ...doc.data() };
};
