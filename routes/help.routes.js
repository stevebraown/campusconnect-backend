// Help center and journey tracking routes
import express from 'express';
import { firestore } from '../config/firebaseAdmin.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { asyncHandler, sendSuccess, sendError } from '../middleware/errorHandler.js';
import { validateBody, validateParams } from '../middleware/validation.js';

const router = express.Router();
const helpCategoriesRef = firestore.collection('helpCategories');
const helpJourneysRef = firestore.collection('helpJourneys');

// Get all help categories (public for authenticated users)
router.get('/categories',
  requireAuth,
  asyncHandler(async (req, res) => {
    const snapshot = await helpCategoriesRef.orderBy('order', 'asc').get();
    const categories = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    return sendSuccess(res, { categories });
  })
);

// Get a single help category by ID
router.get('/categories/:id',
  requireAuth,
  validateParams({ id: { required: true } }),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const doc = await helpCategoriesRef.doc(id).get();

    if (!doc.exists) {
      return sendError(res, 'Help category not found', 404);
    }

    return sendSuccess(res, { id: doc.id, ...doc.data() });
  })
);

// Log a help journey event
router.post('/journeys',
  requireAuth,
  validateBody({
    categoryId: { type: 'string', required: true },
    step: { type: 'string', required: true, enum: ['selfHelp', 'peer', 'professional'] },
    action: { type: 'string', required: true, enum: ['view', 'click'] },
    resourceId: { type: 'string', required: false },
  }),
  asyncHandler(async (req, res) => {
    const { categoryId, step, action, resourceId } = req.body;
    const userId = req.user.uid;
    const now = new Date().toISOString();

    const eventData = {
      userId,
      categoryId,
      step,
      action,
      resourceId: resourceId || null,
      createdAt: now,
    };

    const docRef = await helpJourneysRef.add(eventData);
    return sendSuccess(res, { id: docRef.id, ...eventData }, 201);
  })
);

// ============ ADMIN ROUTES ============

// Admin: Create a help category
router.post('/admin/categories',
  requireAuth,
  requireAdmin,
  validateBody({
    id: { type: 'string', required: true, minLength: 1, maxLength: 50 },
    label: { type: 'string', required: true, minLength: 1, maxLength: 100 },
    icon: { type: 'string', required: false, maxLength: 50 },
    order: { type: 'number', required: true, min: 0 },
    selfHelp: { type: 'object', required: true },
    peer: { type: 'object', required: true },
    professional: { type: 'object', required: true },
  }),
  asyncHandler(async (req, res) => {
    const { id, label, icon, order, selfHelp, peer, professional } = req.body;
    const now = new Date().toISOString();

    // Validate structure
    if (!selfHelp.items || !Array.isArray(selfHelp.items)) {
      return sendError(res, 'selfHelp.items must be an array', 400);
    }
    if (!peer.groupsTopics || !Array.isArray(peer.groupsTopics)) {
      return sendError(res, 'peer.groupsTopics must be an array', 400);
    }
    if (!peer.mentors || !Array.isArray(peer.mentors)) {
      return sendError(res, 'peer.mentors must be an array', 400);
    }
    if (!professional.services || !Array.isArray(professional.services)) {
      return sendError(res, 'professional.services must be an array', 400);
    }

    const categoryData = {
      label: label.trim(),
      icon: icon ? icon.trim() : null,
      order: Number(order),
      selfHelp,
      peer,
      professional,
      createdAt: now,
      updatedAt: now,
    };

    await helpCategoriesRef.doc(id).set(categoryData);
    return sendSuccess(res, { id, ...categoryData }, 201);
  })
);

// Admin: Update a help category
router.patch('/admin/categories/:id',
  requireAuth,
  requireAdmin,
  validateParams({ id: { required: true } }),
  validateBody({
    label: { type: 'string', required: false, minLength: 1, maxLength: 100 },
    icon: { type: 'string', required: false, maxLength: 50 },
    order: { type: 'number', required: false, min: 0 },
    selfHelp: { type: 'object', required: false },
    peer: { type: 'object', required: false },
    professional: { type: 'object', required: false },
  }),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const updates = req.body;
    const docRef = helpCategoriesRef.doc(id);
    const doc = await docRef.get();

    if (!doc.exists) {
      return sendError(res, 'Help category not found', 404);
    }

    const updateData = {
      ...updates,
      updatedAt: new Date().toISOString(),
    };

    await docRef.update(updateData);
    return sendSuccess(res, { id, ...updateData });
  })
);

// Admin: Delete a help category
router.delete('/admin/categories/:id',
  requireAuth,
  requireAdmin,
  validateParams({ id: { required: true } }),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const docRef = helpCategoriesRef.doc(id);
    const doc = await docRef.get();

    if (!doc.exists) {
      return sendError(res, 'Help category not found', 404);
    }

    await docRef.delete();
    return sendSuccess(res, { id, message: 'Category deleted' });
  })
);

// Admin: Get help journey events (analytics)
router.get('/admin/journeys',
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { limit = 100, categoryId, step, userId } = req.query;
    let query = helpJourneysRef.orderBy('createdAt', 'desc').limit(Number(limit));

    if (categoryId) {
      query = query.where('categoryId', '==', categoryId);
    }
    if (step) {
      query = query.where('step', '==', step);
    }
    if (userId) {
      query = query.where('userId', '==', userId);
    }

    const snapshot = await query.get();
    const events = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    return sendSuccess(res, { events });
  })
);

export default router;
