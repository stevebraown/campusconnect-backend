/**
 * Help AI Routes
 * Routes for AI-powered help and support
 */

import express from "express";
import { requireAuth } from "../middleware/auth.js";
import { validateBody } from "../middleware/validation.js";
import { asyncHandler } from "../middleware/errorHandler.js";
import { handleHelpAIRequest } from "../controllers/helpAI.controller.js";
// NOTE: Help AI uses the internal help controller (not the campusconnect-ai /run-graph service).

const router = express.Router();

/**
 * POST /api/help/ai
 * Ask a question to the AI help assistant
 * 
 * Request body:
 * - question: string (required, 1-1000 chars)
 * - history: array of { role: "user" | "assistant", content: string } (optional)
 * 
 * Response:
 * - success: true
 * - data: { answer: string, sources: string[] }
 */
router.post(
  "/",
  requireAuth,
  (req, res, next) => {
    // Debug logging in development
    if (process.env.NODE_ENV === "development") {
      console.log("📥 AI Help request received:", {
        question: req.body?.question?.substring(0, 50),
        questionLength: req.body?.question?.length,
        historyLength: req.body?.history?.length || 0,
        hasHistory: !!req.body?.history,
      });
    }
    next();
  },
  validateBody({
    question: {
      type: "string",
      required: true,
      minLength: 1,
      maxLength: 1000,
    },
    history: {
      type: "array",
      required: false,
    },
  }),
  asyncHandler(handleHelpAIRequest)
);

export default router;
