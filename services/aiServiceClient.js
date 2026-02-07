// ============================================================
// AI SERVICE CLIENT
// Calls the campusconnect-ai FastAPI service at /run-graph.
// Includes Authorization header with shared token for security.
// ============================================================

/**
 * CampusConnect AI service client.
 * Purpose: Centralized helper for calling the campusconnect-ai FastAPI /run-graph endpoint.
 * Connection: Express backend → AI service via AI_SERVICE_URL.
 */

// AI service base URL (FastAPI /run-graph) configured via backend .env.
// Normalized to remove trailing slashes and dots to prevent malformed URLs.
const normalizeUrl = (url) => {
  if (!url) return 'http://localhost:8000';
  return url.replace(/\.+$/, '').replace(/\/+$/, ''); // Remove trailing dots and slashes.
};

const AI_SERVICE_URL = normalizeUrl(process.env.AI_SERVICE_URL || 'http://localhost:8000');
const AI_SERVICE_TOKEN = process.env.AI_SERVICE_TOKEN || '';
// Configurable timeout for AI service requests to protect backend availability.
// This ensures hung or slow AI calls do not tie up Node.js workers indefinitely.
const AI_SERVICE_TIMEOUT_MS = Number(process.env.AI_SERVICE_TIMEOUT_MS || '15000');

/**
 * Run a graph on the CampusConnect AI service.
 * Graphs: matching | events_communities | onboarding | safety.
 * Used by student-facing routes and admin monitoring routes.
 * Includes Authorization header if AI_SERVICE_TOKEN is set.
 * @param {Object} request - { graph, input }
 * @returns {Promise<Object>} - Parsed JSON from the AI service
 * @throws {Error} on network or service errors
 */
export const runAiGraph = async (request) => {
  // Build headers with Content-Type and optional Authorization
  const headers = {
    'Content-Type': 'application/json',
  };

  // Add Authorization header if token is configured
  if (AI_SERVICE_TOKEN) {
    headers.Authorization = `Bearer ${AI_SERVICE_TOKEN}`;
  }

  // AI-driven call to the external FastAPI service with an explicit timeout.
  // AbortController ensures we fail fast and surface a clear 504-style error to routes.
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, AI_SERVICE_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(`${AI_SERVICE_URL}/run-graph`, {
      method: 'POST',
      headers,
      body: JSON.stringify(request),
      signal: controller.signal,
    });
  } catch (err) {
    if (err && err.name === 'AbortError') {
      const timeoutError = new Error(
        `AI service request timed out after ${AI_SERVICE_TIMEOUT_MS}ms`
      );
      timeoutError.status = 504;
      throw timeoutError;
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }

  // Parse response body safely for both success and error cases.
  const rawText = await response.text();
  let payload = null;
  try {
    payload = rawText ? JSON.parse(rawText) : null;
  } catch (parseError) {
    payload = { error: 'Invalid JSON from AI service', raw: rawText };
  }

  // Throw with status so routes can return 502/500 cleanly.
  if (!response.ok) {
    const error = new Error(`AI service error: ${response.status}`);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }

  return payload;
};

export default {
  runAiGraph,
};
