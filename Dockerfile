# Multi-stage build: dependencies + runtime
FROM node:20-alpine AS dependencies

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install production dependencies
RUN npm ci --omit=dev

# Runtime stage
FROM node:20-alpine AS runtime

WORKDIR /app

# Copy node_modules from dependencies stage
COPY --from=dependencies /app/node_modules ./node_modules

# Copy source code
COPY . ./

# Create non-root user
RUN addgroup -S appuser && \
  adduser -S -G appuser appuser && \
  chown -R appuser:appuser /app

USER appuser

# Expose port
EXPOSE 5001

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:5001/api/health', (r) => { if (r.statusCode !== 200) throw new Error(r.statusCode) })"

# Start server
CMD ["npm", "start"]
