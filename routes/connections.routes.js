// Connection request and relationship routes
import express from 'express';
import { firestore } from '../config/firebaseAdmin.js';
import { requireAuth } from '../middleware/auth.js';

const router = express.Router();
const connectionsRef = firestore.collection('connections');
const profilesRef = firestore.collection('profiles');
const usersRef = firestore.collection('users');
const threadsRef = firestore.collection('threads');

const CONNECTION_STATUS = {
  PENDING: 'pending',
  ACCEPTED: 'accepted',
  REJECTED: 'rejected',
};

const buildConnectionId = (a, b) => [a, b].sort().join('_');

// Send connection request
router.post('/request', requireAuth, async (req, res) => {
  try {
    const fromUserId = req.user.uid;
    const { toUserId } = req.body || {};
    if (!toUserId) return res.status(400).json({ error: 'toUserId is required' });
    if (toUserId === fromUserId) return res.status(400).json({ error: 'Cannot connect to yourself' });

    const connectionId = buildConnectionId(fromUserId, toUserId);
    const docRef = connectionsRef.doc(connectionId);
    const snap = await docRef.get();

    if (snap.exists) {
      const data = snap.data();
      return res.json({ success: true, connectionId, status: data.status });
    }

    const now = new Date().toISOString();
    const payload = {
      fromUserId,
      toUserId,
      status: CONNECTION_STATUS.PENDING,
      createdAt: now,
      updatedAt: now,
    };

    await docRef.set(payload);
    return res.json({ success: true, connectionId, status: CONNECTION_STATUS.PENDING });
  } catch (err) {
    console.error('Send request error:', err);
    return res.status(500).json({ error: 'Failed to send request' });
  }
});

// Pending requests for current user
router.get('/requests', requireAuth, async (req, res) => {
  try {
    const uid = req.user.uid;
    const q = await connectionsRef
      .where('toUserId', '==', uid)
      .where('status', '==', CONNECTION_STATUS.PENDING)
      .get();

    // Populate user info for each request
    const requests = await Promise.all(
      q.docs.map(async (doc) => {
        const data = doc.data();
        const fromUserId = data.fromUserId;
        
        // Fetch user and profile data
        const [userSnap, profileSnap] = await Promise.all([
          usersRef.doc(fromUserId).get(),
          profilesRef.doc(fromUserId).get(),
        ]);
        
        const userData = userSnap.exists ? userSnap.data() : {};
        const profileData = profileSnap.exists ? profileSnap.data() : {};
        
        return {
          id: doc.id,
          ...data,
          fromUserName: profileData.name || userData.name || userData.email || 'Unknown User',
          fromUserEmail: userData.email || '',
        };
      })
    );
    
    return res.json({ success: true, requests });
  } catch (err) {
    console.error('Get requests error:', err);
    return res.status(500).json({ error: 'Failed to load requests' });
  }
});

// Accepted connections for current user
router.get('/list', requireAuth, async (req, res) => {
  try {
    const uid = req.user.uid;
    const [fromSnap, toSnap] = await Promise.all([
      connectionsRef.where('fromUserId', '==', uid).where('status', '==', CONNECTION_STATUS.ACCEPTED).get(),
      connectionsRef.where('toUserId', '==', uid).where('status', '==', CONNECTION_STATUS.ACCEPTED).get(),
    ]);

    const connections = [
      ...fromSnap.docs.map((d) => ({ id: d.id, ...d.data(), connectedUserId: d.data().toUserId })),
      ...toSnap.docs.map((d) => ({ id: d.id, ...d.data(), connectedUserId: d.data().fromUserId })),
    ];

    return res.json({ success: true, connections });
  } catch (err) {
    console.error('Get connections error:', err);
    return res.status(500).json({ error: 'Failed to load connections' });
  }
});

const requireParticipant = async (connectionId, uid) => {
  const snap = await connectionsRef.doc(connectionId).get();
  if (!snap.exists) return { allowed: false, status: 404, message: 'Connection not found' };
  const data = snap.data();
  const isParticipant = data.fromUserId === uid || data.toUserId === uid;
  if (!isParticipant) return { allowed: false, status: 403, message: 'Forbidden' };
  return { allowed: true, data };
};

// Accept request
router.patch('/:id/accept', requireAuth, async (req, res) => {
  try {
    const uid = req.user.uid;
    const connectionId = req.params.id;
    const check = await requireParticipant(connectionId, uid);
    if (!check.allowed) return res.status(check.status).json({ error: check.message });

    const connectionData = check.data;
    const otherUserId = connectionData.fromUserId === uid ? connectionData.toUserId : connectionData.fromUserId;
    const userIds = [uid, otherUserId].sort();
    const threadId = userIds.join('_');

    const now = new Date().toISOString();
    
    // Update connection status
    await connectionsRef.doc(connectionId).update({
      status: CONNECTION_STATUS.ACCEPTED,
      acceptedAt: now,
      updatedAt: now,
    });

    // Create or ensure thread exists
    const threadRef = threadsRef.doc(threadId);
    const threadSnap = await threadRef.get();
    
    if (!threadSnap.exists) {
      await threadRef.set({
        userIds,
        createdAt: now,
        lastMessageAt: null,
      });
    }

    return res.json({ success: true, status: CONNECTION_STATUS.ACCEPTED, threadId });
  } catch (err) {
    console.error('Accept connection error:', err);
    return res.status(500).json({ error: 'Failed to accept connection' });
  }
});

// Reject request
router.patch('/:id/reject', requireAuth, async (req, res) => {
  try {
    const uid = req.user.uid;
    const connectionId = req.params.id;
    const check = await requireParticipant(connectionId, uid);
    if (!check.allowed) return res.status(check.status).json({ error: check.message });

    const now = new Date().toISOString();
    await connectionsRef.doc(connectionId).update({
      status: CONNECTION_STATUS.REJECTED,
      rejectedAt: now,
      updatedAt: now,
    });

    return res.json({ success: true, status: CONNECTION_STATUS.REJECTED });
  } catch (err) {
    console.error('Reject connection error:', err);
    return res.status(500).json({ error: 'Failed to reject connection' });
  }
});

// Get connection status between current user and another user
router.get('/status/:userId', requireAuth, async (req, res) => {
  try {
    const currentUserId = req.user.uid;
    const otherUserId = req.params.userId;
    
    if (currentUserId === otherUserId) {
      return res.json({ success: true, status: null, connection: null });
    }
    
    const connectionId = buildConnectionId(currentUserId, otherUserId);
    const docSnap = await connectionsRef.doc(connectionId).get();
    
    if (!docSnap.exists) {
      return res.json({ success: true, status: null, connection: null });
    }
    
    const data = docSnap.data();
    // Determine direction: is this an outgoing request (from current user) or incoming (to current user)
    const isOutgoing = data.fromUserId === currentUserId;
    const isIncoming = data.toUserId === currentUserId;
    
    return res.json({
      success: true,
      status: data.status,
      connection: {
        id: docSnap.id,
        ...data,
        isOutgoing,
        isIncoming,
      },
    });
  } catch (err) {
    console.error('Get connection status error:', err);
    return res.status(500).json({ error: 'Failed to get connection status' });
  }
});

// Get thread ID for a connection (returns null if connection not accepted)
router.get('/thread/:userId', requireAuth, async (req, res) => {
  try {
    const currentUserId = req.user.uid;
    const otherUserId = req.params.userId;
    
    const connectionId = buildConnectionId(currentUserId, otherUserId);
    const connectionSnap = await connectionsRef.doc(connectionId).get();
    
    if (!connectionSnap.exists || connectionSnap.data().status !== CONNECTION_STATUS.ACCEPTED) {
      return res.json({ success: true, threadId: null });
    }
    
    const userIds = [currentUserId, otherUserId].sort();
    const threadId = userIds.join('_');
    
    return res.json({ success: true, threadId });
  } catch (err) {
    console.error('Get thread error:', err);
    return res.status(500).json({ error: 'Failed to get thread' });
  }
});

export default router;
