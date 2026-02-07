// User profile and directory routes
import express from 'express';
import geohash from 'ngeohash';
import { firestore } from '../config/firebaseAdmin.js';
import { requireAuth, requireOwnership } from '../middleware/auth.js';
import { haversineDistance, pointInsideGeofence as checkPointInsideGeofence } from '../utils/geo.js';

const router = express.Router();
const profilesRef = firestore.collection('profiles');
const usersRef = firestore.collection('users');
const matchesRef = firestore.collection('matches');
const adminRef = firestore.collection('admin');

// Default geofence settings (fallback)
const DEFAULT_GEOFENCE = {
  enabled: true,
  centerLat: 51.505,
  centerLng: 0.05,
  radiusMeters: 1000,
};

// Get geofence settings from Firestore (with fallback to env vars and defaults)
const getGeofenceSettings = async () => {
  try {
    const geofenceDoc = await adminRef.doc('geofence').get();
    if (geofenceDoc.exists) {
      const data = geofenceDoc.data();
      // Explicitly check for true (defaults to false if not set or explicitly false)
      return {
        enabled: data.enabled === true,
        centerLat: data.centerLat ?? Number(process.env.GEOFENCE_CENTER_LAT) ?? DEFAULT_GEOFENCE.centerLat,
        centerLng: data.centerLng ?? Number(process.env.GEOFENCE_CENTER_LNG) ?? DEFAULT_GEOFENCE.centerLng,
        radiusMeters: data.radiusMeters ?? Number(process.env.GEOFENCE_RADIUS_M) ?? DEFAULT_GEOFENCE.radiusMeters,
      };
    }
  } catch (err) {
    console.error('Error loading geofence settings:', err);
  }
  
  // Fallback: If no Firestore settings and no env vars, disable geofencing for development
  // This allows location updates to work out of the box
  const hasEnvVars = process.env.GEOFENCE_CENTER_LAT && process.env.GEOFENCE_CENTER_LNG && process.env.GEOFENCE_RADIUS_M;
  
  return {
    enabled: hasEnvVars ? (Number(process.env.GEOFENCE_ENABLED) === 1) : false, // Disable if no explicit config
    centerLat: Number(process.env.GEOFENCE_CENTER_LAT) || DEFAULT_GEOFENCE.centerLat,
    centerLng: Number(process.env.GEOFENCE_CENTER_LNG) || DEFAULT_GEOFENCE.centerLng,
    radiusMeters: Number(process.env.GEOFENCE_RADIUS_M) || DEFAULT_GEOFENCE.radiusMeters,
  };
};

// Check if point is inside geofence (uses Firestore settings)
const pointInsideGeofence = async (lat, lng) => {
  const settings = await getGeofenceSettings();
  if (!settings.enabled) return true; // If geofencing disabled, allow all locations
  return checkPointInsideGeofence(lat, lng, settings.centerLat, settings.centerLng, settings.radiusMeters);
};

const sanitizeProfile = (profile) => {
  if (!profile) return {};
  const { name, major, year, interests, bio, avatarUrl, locationEnabled } = profile;
  return {
    name: name || '',
    major: major || '',
    year: year || null,
    interests: Array.isArray(interests) ? interests.slice(0, 20) : [],
    bio: bio || '',
    avatarUrl: avatarUrl || '',
    locationEnabled: typeof locationEnabled === 'boolean' ? locationEnabled : false,
  };
};

// Get current user profile
router.get('/me', requireAuth, async (req, res) => {
  try {
    const uid = req.user.uid;
    const [userSnap, profileSnap] = await Promise.all([
      usersRef.doc(uid).get(),
      profilesRef.doc(uid).get(),
    ]);

    const userData = userSnap.exists ? { uid, ...userSnap.data() } : null;
    const profileData = profileSnap.exists ? { uid, ...profileSnap.data() } : null;

    return res.json({
      success: true,
      user: userData,
      profile: profileData,
    });
  } catch (err) {
    console.error('Get me error:', err);
    return res.status(500).json({ success: false, error: 'Failed to load profile' });
  }
});

// Get current user settings (notifications, privacy)
router.get('/me/settings', requireAuth, async (req, res) => {
  try {
    const uid = req.user.uid;
    const profileSnap = await profilesRef.doc(uid).get();
    const data = profileSnap.exists ? profileSnap.data() : {};
    const settings = data.settings || {};
    const notifications = {
      email: settings.notifications?.email ?? true,
      push: settings.notifications?.push ?? false,
      matches: settings.notifications?.matches ?? true,
      connections: settings.notifications?.connections ?? true,
    };
    const privacy = {
      profileVisible: settings.privacy?.profileVisible ?? true,
      showLocation: settings.privacy?.showLocation ?? false,
      showEmail: settings.privacy?.showEmail ?? false,
    };
    return res.json({
      success: true,
      settings: { notifications, privacy },
    });
  } catch (err) {
    console.error('Get settings error:', err);
    return res.status(500).json({ success: false, error: 'Failed to load settings' });
  }
});

// Update current user settings (notifications, privacy)
router.patch('/me/settings', requireAuth, async (req, res) => {
  try {
    const uid = req.user.uid;
    const { notifications, privacy } = req.body || {};
    const profileSnap = await profilesRef.doc(uid).get();
    const existing = profileSnap.exists ? profileSnap.data() : {};
    const existingSettings = existing.settings || {};
    const existingNotif = existingSettings.notifications || {};
    const existingPriv = existingSettings.privacy || {};
    const newSettings = { ...existingSettings };

    if (typeof notifications === 'object') {
      newSettings.notifications = {
        email: typeof notifications.email === 'boolean' ? notifications.email : (existingNotif.email ?? true),
        push: typeof notifications.push === 'boolean' ? notifications.push : (existingNotif.push ?? false),
        matches: typeof notifications.matches === 'boolean' ? notifications.matches : (existingNotif.matches ?? true),
        connections: typeof notifications.connections === 'boolean' ? notifications.connections : (existingNotif.connections ?? true),
      };
    }
    if (typeof privacy === 'object') {
      newSettings.privacy = {
        profileVisible: typeof privacy.profileVisible === 'boolean' ? privacy.profileVisible : (existingPriv.profileVisible ?? true),
        showLocation: typeof privacy.showLocation === 'boolean' ? privacy.showLocation : (existingPriv.showLocation ?? false),
        showEmail: typeof privacy.showEmail === 'boolean' ? privacy.showEmail : (existingPriv.showEmail ?? false),
      };
    }
    if (typeof notifications !== 'object' && typeof privacy !== 'object') {
      return res.status(400).json({ error: 'Provide notifications and/or privacy object' });
    }
    await profilesRef.doc(uid).set({ settings: newSettings, updatedAt: new Date().toISOString() }, { merge: true });
    return res.json({
      success: true,
      settings: { notifications: newSettings.notifications || {}, privacy: newSettings.privacy || {} },
    });
  } catch (err) {
    console.error('Update settings error:', err);
    return res.status(500).json({ success: false, error: 'Failed to update settings' });
  }
});

// Get directory of users (public profiles, excludes current user)
router.get('/', requireAuth, async (req, res) => {
  try {
    const currentUserId = req.user.uid;
    const limit = parseInt(req.query.limit) || 50;
    const offset = parseInt(req.query.offset) || 0;

    // Fetch profiles (with reasonable max limit for filtering)
    // In production, consider cursor-based pagination for better performance
    const maxFetch = 200; // Reasonable limit for small-to-medium campuses
    const snapshot = await profilesRef.limit(maxFetch).get();

    const allProfiles = [];
    snapshot.forEach((doc) => {
      // Skip current user
      if (doc.id === currentUserId) return;

      const data = doc.data();
      // Return only public profile fields (exclude sensitive data)
      allProfiles.push({
        id: doc.id,
        userId: doc.id,
        name: data.name || '',
        major: data.major || '',
        year: data.year || null,
        interests: Array.isArray(data.interests) ? data.interests : [],
        bio: data.bio || '',
        avatarUrl: data.avatarUrl || '',
        // Include location if available (for distance calculations)
        locationLat: typeof data.locationLat === 'number' ? data.locationLat : null,
        locationLng: typeof data.locationLng === 'number' ? data.locationLng : null,
      });
    });

    // Apply pagination after filtering
    const paginatedProfiles = allProfiles.slice(offset, offset + limit);

    return res.json({
      success: true,
      profiles: paginatedProfiles,
      total: allProfiles.length,
      returned: paginatedProfiles.length,
      limit,
      offset,
    });
  } catch (err) {
    console.error('Get directory error:', err);
    return res.status(500).json({ error: 'Failed to load directory' });
  }
});

// Update location (lat/lng) for own profile
// NOTE: This route must come BEFORE /:id routes to ensure proper matching
// CRITICAL: Express Router matches routes in order, so /:id/location must be before /:id
router.patch('/:id/location', requireAuth, requireOwnership('id'), async (req, res) => {
  try {
    const userId = req.params.id;
    
    // Debug logging
    console.log('📍 Location update request received:', {
      method: req.method,
      path: req.path,
      route: req.route?.path,
      userId,
      body: req.body,
    });

    const { lat, lng } = req.body || {};

    // Convert to numbers if they're strings (defensive type coercion)
    const latNum = typeof lat === 'number' ? lat : (typeof lat === 'string' ? parseFloat(lat) : null);
    const lngNum = typeof lng === 'number' ? lng : (typeof lng === 'string' ? parseFloat(lng) : null);

    // Validate that we have valid numbers
    if (latNum === null || lngNum === null || isNaN(latNum) || isNaN(lngNum)) {
      console.error('❌ Location update validation failed:', { 
        received: { lat, lng, latType: typeof lat, lngType: typeof lng },
        parsed: { latNum, lngNum },
      });
      return res.status(400).json({ error: 'Provide valid lat/lng as numbers' });
    }

    const coords = { lat: latNum, lng: lngNum };

    // Geofence enforcement - check if geofencing is enabled first
    const geofenceSettings = await getGeofenceSettings();
    console.log('📍 Geofence settings:', { enabled: geofenceSettings.enabled, center: [geofenceSettings.centerLat, geofenceSettings.centerLng], radius: geofenceSettings.radiusMeters });
    
    if (geofenceSettings.enabled) {
      const insideCampus = await pointInsideGeofence(coords.lat, coords.lng);
      console.log('📍 Geofence check (enabled):', { lat: coords.lat, lng: coords.lng, insideCampus });
      if (!insideCampus) {
        console.log('❌ Location outside geofence');
        return res.status(400).json({ error: 'Location outside campus geofence' });
      }
    } else {
      console.log('📍 Geofencing disabled - allowing location update');
    }

    const geohashStr = geohash.encode(coords.lat, coords.lng, 6);
    const update = {
      locationLat: coords.lat,
      locationLng: coords.lng,
      locationText: '',
      locationUpdatedAt: new Date().toISOString(),
      geohash: geohashStr,
    };

    await profilesRef.doc(userId).set(update, { merge: true });

    // Proximity suggestions: Find ALL nearby students (not just matches) who meet criteria
    // Criteria: < 100m distance, both locationEnabled=true, matching programme, overlapping interests
    const currentProfileSnap = await profilesRef.doc(userId).get();
    if (!currentProfileSnap.exists) {
      console.log('✅ Location update successful (no profile for proximity check):', { userId, location: update });
      return res.json({ success: true, location: update });
    }

    const currentProfile = currentProfileSnap.data();
    
    // Skip proximity check if current user doesn't have location enabled
    if (currentProfile.locationEnabled !== true) {
      console.log('✅ Location update successful (locationEnabled=false):', { userId, location: update });
      return res.json({ success: true, location: update });
    }

    const recentThresholdMs = 5 * 60 * 1000; // 5 minutes
    const now = Date.now();
    const io = req.app.get('io');

    // Query nearby profiles via geohash index (center + 8 neighbors for 100m coverage)
    const centerHash = geohash.encode(coords.lat, coords.lng, 6);
    const nearbyHashes = [centerHash, ...geohash.neighbors(centerHash)];
    const suggestions = [];

    const candidateSnaps = await Promise.all(
      nearbyHashes.map((h) =>
        profilesRef
          .where('locationEnabled', '==', true)
          .where('geohash', '==', h)
          .get()
      )
    );

    const seenIds = new Set([userId]);
    for (const snap of candidateSnaps) {
      for (const doc of snap.docs) {
        const otherUserId = doc.id;
        if (seenIds.has(otherUserId)) continue;
        seenIds.add(otherUserId);

        const otherProfile = doc.data();

        // Check 1: Must have valid location data
        if (
          typeof otherProfile.locationLat !== 'number' ||
          typeof otherProfile.locationLng !== 'number' ||
          !otherProfile.locationUpdatedAt
        ) {
          continue;
        }

        // Check 2: Location must be recent (within 5 minutes)
        const otherTs = new Date(otherProfile.locationUpdatedAt).getTime();
        if (Number.isNaN(otherTs) || now - otherTs > recentThresholdMs) continue;

        // Check 3: Other user must be inside geofence
        const otherInside = await pointInsideGeofence(otherProfile.locationLat, otherProfile.locationLng);
        if (!otherInside) continue;

        // Check 4: Distance must be < 100m
        const dist = haversineDistance(
          coords.lat,
          coords.lng,
          otherProfile.locationLat,
          otherProfile.locationLng,
          'm'
        );

        if (dist >= 100) continue; // Must be < 100m

        // Check 5: Matching programme (major)
        const currentMajor = (currentProfile.major || '').toLowerCase().trim();
        const otherMajor = (otherProfile.major || '').toLowerCase().trim();
        if (!currentMajor || !otherMajor || currentMajor !== otherMajor) continue;

        // Check 6: Overlapping interests
        const currentInterests = Array.isArray(currentProfile.interests) ? currentProfile.interests.map(i => (i || '').toLowerCase().trim()).filter(Boolean) : [];
        const otherInterests = Array.isArray(otherProfile.interests) ? otherProfile.interests.map(i => (i || '').toLowerCase().trim()).filter(Boolean) : [];
        const commonInterests = currentInterests.filter(i => otherInterests.includes(i));
        if (commonInterests.length === 0) continue;

        // All criteria met - this is a valid proximity suggestion
        suggestions.push({
          userId: otherUserId,
          distanceMeters: dist,
          commonInterests,
        });
      }
    }

    // Emit proximity suggestions via Socket.io (if connected)
    if (io && suggestions.length > 0) {
      for (const suggestion of suggestions) {
        const payload = {
          users: [userId, suggestion.userId],
          distanceMeters: suggestion.distanceMeters,
          commonInterests: suggestion.commonInterests,
          timestamp: new Date().toISOString(),
        };
        const map = io.userSockets;
        const uSet = map?.get(userId);
        const oSet = map?.get(suggestion.userId);
        [...(uSet || []), ...(oSet || [])].forEach((sid) => {
          io.to(sid).emit('proximity:nearby-suggestion', payload);
        });
      }
    }

    console.log('✅ Location update successful:', { userId, location: update });
    return res.json({ success: true, location: update });
  } catch (err) {
    console.error('❌ Update location error:', err);
    return res.status(500).json({ error: 'Failed to update location' });
  }
});

// Get profile by user id
router.get('/:id/profile', requireAuth, async (req, res) => {
  try {
    const userId = req.params.id;
    const profileSnap = await profilesRef.doc(userId).get();

    if (!profileSnap.exists) {
      return res.status(404).json({ success: false, error: 'Profile not found' });
    }

    return res.json({
      success: true,
      profile: { uid: userId, ...profileSnap.data() },
    });
  } catch (err) {
    console.error('Get profile error:', err);
    return res.status(500).json({ success: false, error: 'Failed to load profile' });
  }
});

// Get user by user id
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const userId = req.params.id;
    const [userSnap, profileSnap] = await Promise.all([
      usersRef.doc(userId).get(),
      profilesRef.doc(userId).get(),
    ]);

    if (!userSnap.exists) return res.status(404).json({ success: false, error: 'User not found' });

    return res.json({
      success: true,
      user: { uid: userId, ...userSnap.data() },
      profile: profileSnap.exists ? { uid: userId, ...profileSnap.data() } : null,
    });
  } catch (err) {
    console.error('Get user error:', err);
    return res.status(500).json({ success: false, error: 'Failed to load user' });
  }
});

// Update own profile
router.put('/:id', requireAuth, requireOwnership('id'), async (req, res) => {
  try {
    const userId = req.params.id;
    const profileData = sanitizeProfile(req.body || {});

    await profilesRef.doc(userId).set(
      {
        ...profileData,
        updatedAt: new Date().toISOString(),
      },
      { merge: true }
    );

    return res.json({ success: true, profile: profileData });
  } catch (err) {
    console.error('Update profile error:', err);
    return res.status(500).json({ error: 'Failed to update profile' });
  }
});

export default router;