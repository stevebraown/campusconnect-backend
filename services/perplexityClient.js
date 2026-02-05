/**
 * Perplexity AI Client
 * Handles API communication with Perplexity Chat Completions
 */

/**
 * Parse allowed domains from environment variable
 * @param {string} envStr - Comma-separated domain string
 * @returns {string[]} - Array of trimmed, non-empty domains
 */
function parseAllowedDomains(envStr) {
  const raw = envStr || "";
  return raw
    .split(",")
    .map((d) => d.trim())
    .filter(Boolean);
}

/**
 * Extract URLs from text using regex
 * @param {string} text - Text to search for URLs
 * @returns {string[]} - Array of unique URLs
 */
function extractUrlsFromText(text) {
  if (!text || typeof text !== "string") return [];
  
  const urlRegex = /https?:\/\/[^\s<>"{}|\\^`\[\]]+/gi;
  const matches = text.match(urlRegex) || [];
  
  // Deduplicate and normalize
  const uniqueUrls = [...new Set(matches.map(url => url.trim()))];
  return uniqueUrls;
}

/**
 * Perplexity API Client
 */
class PerplexityClient {
  constructor() {
    this.apiKey = process.env.PPLX_API_KEY;
    this.model = process.env.PPLX_MODEL || "sonar-pro";
    this.allowedDomains = parseAllowedDomains(process.env.PPLX_ALLOWED_DOMAINS);
    this.baseUrl = "https://api.perplexity.ai";
    this.timeout = 30000; // 30 seconds

    // Validate configuration
    if (!this.apiKey || this.apiKey === "your-perplexity-api-key" || this.apiKey.trim() === "") {
      throw new Error(
        "PPLX_API_KEY is not configured. Please set it in your .env file."
      );
    }

    if (this.allowedDomains.length === 0) {
      console.warn(
        "⚠️ PPLX_ALLOWED_DOMAINS is empty. Perplexity will search all domains."
      );
    } else {
      console.log(
        `✅ Perplexity configured with ${this.allowedDomains.length} allowed domain(s): ${this.allowedDomains.join(", ")}`
      );
    }
  }

  /**
   * Make a chat completion request to Perplexity
   * @param {Object} options
   * @param {Array} options.messages - Array of message objects { role, content }
   * @returns {Promise<{ answer: string, sources: string[] }>}
   */
  async chat({ messages }) {
    if (!Array.isArray(messages) || messages.length === 0) {
      throw new Error("Messages array is required and must not be empty");
    }

    const requestBody = {
      model: this.model,
      messages: messages,
      search_domain_filter: this.allowedDomains.length > 0 ? this.allowedDomains : undefined,
      temperature: 0.7,
      max_tokens: 1000,
    };

    // Remove undefined fields
    if (requestBody.search_domain_filter === undefined) {
      delete requestBody.search_domain_filter;
    }

    const url = `${this.baseUrl}/chat/completions`;

    try {
      // Create AbortController for timeout
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeout);

      const response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text();
        let errorData;
        try {
          errorData = JSON.parse(errorText);
        } catch {
          errorData = { message: errorText || `HTTP ${response.status}` };
        }

        // Log detailed error for debugging
        console.error("❌ Perplexity API error:", {
          status: response.status,
          statusText: response.statusText,
          error: errorData,
        });

        const error = new Error(
          errorData.message || errorData.error?.message || `Perplexity API error: ${response.status}`
        );
        error.status = response.status;
        error.data = errorData;
        throw error;
      }

      const data = await response.json();

      // Extract answer from response
      if (
        !data.choices ||
        !Array.isArray(data.choices) ||
        data.choices.length === 0 ||
        !data.choices[0].message ||
        !data.choices[0].message.content
      ) {
        throw new Error("Invalid response format from Perplexity API");
      }

      const answer = data.choices[0].message.content;

      // Extract sources from citations or fallback to URL extraction
      let sources = [];

      // Try to get citations from response
      if (data.citations && Array.isArray(data.citations)) {
        sources = data.citations
          .map((citation) => {
            if (typeof citation === "string") return citation;
            if (citation.url) return citation.url;
            return null;
          })
          .filter(Boolean);
      }

      // If no citations found, extract URLs from answer text (fallback)
      if (sources.length === 0) {
        sources = extractUrlsFromText(answer);
      }

      // Deduplicate sources
      sources = [...new Set(sources)];

      return {
        answer,
        sources,
      };
    } catch (error) {
      // Handle timeout
      if (error.name === "AbortError") {
        const timeoutError = new Error(
          "Request to Perplexity API timed out. Please try again."
        );
        timeoutError.status = 504;
        throw timeoutError;
      }

      // Handle network errors
      if (error.message && error.message.includes("fetch")) {
        const networkError = new Error(
          "Network error connecting to Perplexity API. Please check your connection."
        );
        networkError.status = 503;
        throw networkError;
      }

      // Re-throw other errors (including API errors)
      throw error;
    }
  }
}

// Create singleton instance
let clientInstance = null;

/**
 * Get or create Perplexity client instance
 * @returns {PerplexityClient}
 */
export function getPerplexityClient() {
  if (!clientInstance) {
    try {
      clientInstance = new PerplexityClient();
    } catch (error) {
      console.error("❌ Failed to initialize Perplexity client:", error.message);
      throw error;
    }
  }
  return clientInstance;
}

// Export default for convenience
export default getPerplexityClient;
