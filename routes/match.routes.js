// Matching and recommendation routes
import express from 'express';
import { firestore } from '../config/firebaseAdmin.js';
import { requireAuth } from '../middleware/auth.js';
import { haversineDistance } from '../utils/geo.js';

const router = express.Router();
const profilesRef = firestore.collection('profiles');
const matchesRef = firestore.collection('matches');

const buildMatchId = (a, b) => [a, b].sort().join('_');

const scoreMatch = (user, candidate, radiusKm) => {
  let score = 30; // base

  const userInterests = Array.isArray(user.interests) ? user.interests : [];
  const candInterests = Array.isArray(candidate.interests) ? candidate.interests : [];
  const overlap = userInterests.filter((i) => candInterests.includes(i));
  score += Math.min(overlap.length * 10, 30);

  if (user.major && candidate.major && user.major.toLowerCase() === candidate.major.toLowerCase()) {
    score += 15;
  }

  if (user.year && candidate.year) {
    const diff = Math.abs(Number(user.year) - Number(candidate.year));
    if (diff === 0) score += 10;
    else if (diff === 1) score += 6;
  }

  // Proximity: if both have coordinates, adjust score and filter by radius
  const uLat = user.locationLat;
  const uLng = user.locationLng;
  const cLat = candidate.locationLat;
  const cLng = candidate.locationLng;

  let distanceKm = null;
  if (typeof uLat === 'number' && typeof uLng === 'number' && typeof cLat === 'number' && typeof cLng === 'number') {
    distanceKm = haversineDistance(uLat, uLng, cLat, cLng, 'km');
    // If outside radius, heavily penalize
    if (radiusKm && distanceKm > radiusKm) {
      score -= 50;
    } else if (distanceKm !== null) {
      // Within radius: closer gets more points (up to +15)
      const proximityBoost = Math.max(0, 15 - Math.min(15, Math.floor(distanceKm)));
      score += proximityBoost;
    }
  }

  return { score: Math.min(score, 100), distanceKm };
};

router.get('/recommendations', requireAuth, async (req, res) => {
  try {
    const uid = req.user.uid;
    const radiusKm = req.query.radiusKm ? Number(req.query.radiusKm) : null;
    const userSnap = await profilesRef.doc(uid).get();
    if (!userSnap.exists) return res.status(400).json({ error: 'User profile missing' });

    const userProfile = userSnap.data();

    const snapshot = await profilesRef.limit(50).get();
    const candidates = snapshot.docs
      .filter((d) => d.id !== uid)
      .map((d) => ({ id: d.id, ...d.data() }));

    const scored = candidates.map((cand) => {
      const { score, distanceKm } = scoreMatch(userProfile, cand, radiusKm);
      return {
        userId: cand.id,
        profile: cand,
        compatibility: score,
        distanceKm,
      };
    });

    // If radius specified, filter to within radius when distance available
    const filtered = scored.filter((item) => {
      if (radiusKm && typeof item.distanceKm === 'number') {
        return item.distanceKm <= radiusKm;
      }
      return true;
    });

    const sorted = filtered.sort((a, b) => b.compatibility - a.compatibility).slice(0, 10);

    return res.json({ success: true, recommendations: sorted });
  } catch (err) {
    console.error('Recommendations error:', err);
    return res.status(500).json({ error: 'Failed to get recommendations' });
  }
});

// Confirm a match between current user and target userId
router.post('/confirm', requireAuth, async (req, res) => {
  try {
    const uid = req.user.uid;
    const { userId, compatibility = null } = req.body || {};
    if (!userId || typeof userId !== 'string') {
      return res.status(400).json({ error: 'userId is required' });
    }
    if (userId === uid) {
      return res.status(400).json({ error: 'Cannot match with yourself' });
    }

    const matchId = buildMatchId(uid, userId);
    const now = new Date().toISOString();

    await matchesRef.doc(matchId).set(
      {
        users: [uid, userId].sort(),
        compatibility,
        matchedAt: now,
        updatedAt: now,
      },
      { merge: true }
    );

    return res.json({ success: true, matchId });
  } catch (err) {
    console.error('Confirm match error:', err);
    return res.status(500).json({ error: 'Failed to confirm match' });
  }
});

// List confirmed matches for current user
router.get('/mine', requireAuth, async (req, res) => {
  try {
    const uid = req.user.uid;
    const snap = await matchesRef.where('users', 'array-contains', uid).get();
    const matches = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    return res.json({ success: true, matches });
  } catch (err) {
    console.error('List matches error:', err);
    return res.status(500).json({ error: 'Failed to list matches' });
  }
});

export default router;