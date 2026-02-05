/**
 * Help AI Controller
 * Handles AI help requests using Perplexity
 */

import { getPerplexityClient } from "../services/perplexityClient.js";
import { sendSuccess, sendError } from "../middleware/errorHandler.js";

/**
 * System prompt for the AI assistant
 */
const SYSTEM_PROMPT = {
  role: "system",
  content: [
    "You are a friendly, casual university help assistant for CampusConnect.",
    "You ONLY use information from domains ending in uel.ac.uk.",
    "Always answer in a concise way (about 2–4 sentences).",
    "When relevant info exists, explicitly offer to provide a short step-by-step guide.",
    "If you are not sure, say you are not sure and point the student to official UEL pages.",
    "Always include clear source links when available.",
  ].join(" "),
};

/**
 * Validate and sanitize conversation history
 * @param {Array} history - Raw history array
 * @returns {Array} - Sanitized history array
 */
function sanitizeHistory(history) {
  if (!Array.isArray(history)) return [];

  return history
    .filter((msg) => {
      // Only allow user or assistant messages
      if (msg.role !== "user" && msg.role !== "assistant") return false;
      // Must have content
      if (!msg.content || typeof msg.content !== "string") return false;
      // Content must not be empty
      if (msg.content.trim().length === 0) return false;
      return true;
    })
    .map((msg) => ({
      role: msg.role,
      content: msg.content.trim(),
    }))
    .slice(-10); // Limit to last 10 messages
}

/**
 * Handle AI help request
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next function
 */
export async function handleHelpAIRequest(req, res, next) {
  try {
    const userId = req.user?.uid;
    if (!userId) {
      return sendError(res, 401, "Authentication required");
    }

    // Validate request body
    const { question, history } = req.body;

    if (!question || typeof question !== "string") {
      return sendError(res, 400, "Question is required and must be a string");
    }

    const trimmedQuestion = question.trim();

    if (trimmedQuestion.length === 0) {
      return sendError(res, 400, "Question cannot be empty");
    }

    if (trimmedQuestion.length > 1000) {
      return sendError(
        res,
        400,
        "Question must be 1000 characters or less"
      );
    }

    // Build messages array
    const messages = [SYSTEM_PROMPT];

    // Add sanitized history if provided
    if (history && Array.isArray(history)) {
      const sanitizedHistory = sanitizeHistory(history);
      messages.push(...sanitizedHistory);
    }

    // Add current question
    messages.push({
      role: "user",
      content: trimmedQuestion,
    });

    // Call Perplexity
    const perplexityClient = getPerplexityClient();
    const result = await perplexityClient.chat({ messages });

    // Log successful request (without sensitive data)
    console.log(
      `✅ AI Help request processed for user ${userId} (question length: ${trimmedQuestion.length})`
    );

    // Return success response
    return sendSuccess(res, {
      answer: result.answer,
      sources: result.sources || [],
    });
  } catch (error) {
    // Log error with user context (truncate question for safety)
    const questionPreview = req.body?.question
      ? req.body.question.substring(0, 50) + "..."
      : "N/A";
    const userId = req.user?.uid || "unknown";

    console.error(
      `❌ AI Help error for user ${userId}:`,
      error.message,
      `(question: ${questionPreview})`
    );
    
    // Log full error stack in development
    if (process.env.NODE_ENV === "development") {
      console.error("Full error:", error);
      if (error.data) {
        console.error("Error data:", error.data);
      }
    }

    // Determine error status
    let statusCode = 500;
    let errorMessage =
      "Unable to process your question right now. Please try again later.";

    if (error.status) {
      statusCode = error.status;
    }

    // Provide more specific error messages for certain cases
    if (error.message?.includes("timeout")) {
      errorMessage =
        "The AI service took too long to respond. Please try again.";
    } else if (error.message?.includes("Network error")) {
      errorMessage =
        "Unable to connect to the AI service. Please check your connection and try again.";
    } else if (error.message?.includes("not configured")) {
      errorMessage =
        "AI service is not configured. Please contact support.";
      // Don't expose configuration errors to users in production
      if (process.env.NODE_ENV === "development") {
        errorMessage = error.message;
      }
    } else if (error.status === 401 || error.status === 403) {
      // Authentication/authorization errors
      if (process.env.NODE_ENV === "development") {
        errorMessage = `Authentication failed: ${error.message || "Invalid API key"}`;
      } else {
        errorMessage = "AI service authentication failed. Please contact support.";
      }
    } else if (error.status === 429) {
      errorMessage = "Too many requests. Please wait a moment and try again.";
    }

    return sendError(res, statusCode, errorMessage);
  }
}
