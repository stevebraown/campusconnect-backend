/**
 * Safety AI routes.
 * Purpose: Student-facing content moderation (messages/profile/icebreakers) via campusconnect-ai /run-graph.
 * Connection: Calls runAiGraph() which talks to the external AI service.
 */

import express from 'express';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler, sendSuccess, sendError } from '../middleware/errorHandler.js';
import { validateBody } from '../middleware/validation.js';
import { runAiGraph } from '../services/aiServiceClient.js';

const router = express.Router();

// AI safety check (student-facing) → graph: safety.
router.post('/check',
  requireAuth,
  validateBody({
    userId: { type: 'string', required: false },
    tenantId: { type: 'string', required: false },
    content: { type: 'string', required: true, minLength: 1, maxLength: 5000 },
    contentType: { type: 'string', required: true },
  }),
  asyncHandler(async (req, res) => {
    // Build AI input using request body with fallbacks from authenticated user.
    const { userId, tenantId, content, contentType } = req.body || {};
    const resolvedUserId = userId || req.user.uid;
    const resolvedTenantId = tenantId || req.user?.data?.tenantId || null;

    try {
      // AI-driven safety call.
      const aiResponse = await runAiGraph({
        graph: 'safety',
        input: {
          user_id: resolvedUserId,
          tenant_id: resolvedTenantId,
          content,
          content_type: contentType,
        },
      });

      // Map AI response into frontend-friendly structure.
      const mapped = {
        safe: aiResponse?.data?.safe ?? true,
        recommendedAction: aiResponse?.data?.recommended_action ?? aiResponse?.data?.recommendedAction ?? 'allow',
        flags: aiResponse?.data?.flags ?? [],
        confidence: aiResponse?.data?.confidence ?? null,
        raw: aiResponse,
      };

      return sendSuccess(res, mapped);
    } catch (err) {
      console.error('Safety AI error:', err);
      return sendError(res, 502, 'Safety AI service unavailable', err?.payload || err?.message);
    }
  })
);

export default router;
