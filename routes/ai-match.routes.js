// Placeholder routes for AI matching features
import express from 'express';
import { requireAuth } from '../middleware/auth.js';
// Error helpers for AI route responses.
import { asyncHandler, sendSuccess, sendError } from '../middleware/errorHandler.js';
import { validateBody, validateParams } from '../middleware/validation.js';
// AI service client used for graph execution.
import { runAiGraph } from '../services/aiServiceClient.js';

const router = express.Router();

// Legacy placeholder for AI matching (non-AI, retained to avoid breaking clients).
router.get('/recommendations/:userId',
  requireAuth,
  validateParams({
    userId: { required: true },
  }),
  asyncHandler(async (req, res) => {
    const { userId } = req.params;
    
    // TODO: Call AI agents module
    // For now, return placeholder
    return sendSuccess(res, {
      message: 'AI matching endpoint ready',
      userId,
      recommendations: [],
    });
  })
);

// AI-powered matching proposals (student-facing) → graph: matching.
router.post('/propose',
  requireAuth,
  validateBody({
    userId: { type: 'string', required: false },
    tenantId: { type: 'string', required: false },
    preferences: { type: 'object', required: false },
  }),
  asyncHandler(async (req, res) => {
    // Build AI input using body with fallbacks from authenticated user.
    const { userId, tenantId, preferences } = req.body || {};
    const resolvedUserId = userId || req.user.uid;
    const resolvedTenantId = tenantId || req.user?.data?.tenantId || null;

    try {
      // AI-driven matching call.
      const aiResponse = await runAiGraph({
        graph: 'matching',
        input: {
          user_id: resolvedUserId,
          tenant_id: resolvedTenantId,
          preferences: preferences || {},
        },
      });

      // Normalize response for the frontend.
      return sendSuccess(res, {
        matches: aiResponse?.data?.final_matches || [],
        meta: aiResponse?.data?.meta || {},
      });
    } catch (err) {
      console.error('AI matching error:', err);
      
      // Handle unauthorized responses (token mismatch)
      if (err.status === 401) {
        console.error('Unauthorized: check AI_SERVICE_TOKEN matches Python service');
        return sendError(res, 502, 'AI service authorization failed', 'Token mismatch or missing');
      }
      
      return sendError(res, 502, 'AI matching service unavailable', err?.payload || err?.message);
    }
  })
);

export default router;