/**
 * Onboarding AI routes.
 * Purpose: Student-facing onboarding validation/next-step assistance via campusconnect-ai /run-graph.
 * Connection: Calls runAiGraph() which talks to the external AI service.
 */

import express from 'express';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler, sendSuccess, sendError } from '../middleware/errorHandler.js';
import { validateBody } from '../middleware/validation.js';
import { runAiGraph } from '../services/aiServiceClient.js';

const router = express.Router();

// AI onboarding step helper (student-facing) → graph: onboarding.
router.post('/step',
  requireAuth,
  validateBody({
    userId: { type: 'string', required: false },
    tenantId: { type: 'string', required: false },
    formData: { type: 'object', required: true },
  }),
  asyncHandler(async (req, res) => {
    // Build AI input using request body with fallbacks from authenticated user.
    const { userId, tenantId, formData } = req.body || {};
    const resolvedUserId = userId || req.user.uid;
    const resolvedTenantId = tenantId || req.user?.data?.tenantId || null;

    try {
      // AI-driven onboarding call.
      const aiResponse = await runAiGraph({
        graph: 'onboarding',
        input: {
          user_id: resolvedUserId,
          tenant_id: resolvedTenantId,
          form_data: formData,
        },
      });

      // Map AI response into frontend-friendly structure.
      const mapped = {
        currentStep: aiResponse?.data?.current_step ?? aiResponse?.data?.currentStep ?? 1,
        isValid: aiResponse?.data?.is_valid ?? aiResponse?.data?.isValid ?? true,
        validationErrors: aiResponse?.data?.validation_errors ?? aiResponse?.data?.validationErrors ?? {},
        profileComplete: aiResponse?.data?.profile_complete ?? aiResponse?.data?.profileComplete ?? false,
        nextPrompt: aiResponse?.data?.next_prompt ?? aiResponse?.data?.nextPrompt ?? null,
        raw: aiResponse,
      };

      return sendSuccess(res, mapped);
    } catch (err) {
      console.error('Onboarding AI error:', err);
      return sendError(res, 502, 'Onboarding AI service unavailable', err?.payload || err?.message);
    }
  })
);

export default router;
