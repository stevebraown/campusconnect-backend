console.log('JWT_SECRET loaded:', process.env.JWT_SECRET ? 'YES' : 'NO');
// Backend API server and Socket.io host
// Load environment variables FIRST
import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import initializeSocket from './socket/socketConfig.js';
import authRoutes from './routes/auth.routes.js';
import userRoutes from './routes/user.routes.js';
import matchRoutes from './routes/match.routes.js';
import connectionsRoutes from './routes/connections.routes.js';
import aiMatchRoutes from './routes/ai-match.routes.js';
import adminRoutes from './routes/admin.routes.js';
import groupsRoutes from './routes/groups.routes.js';
import eventsRoutes from './routes/events.routes.js';
import helpRoutes from './routes/help.routes.js';
import helpAIRoutes from './routes/help-ai.routes.js';
// AI onboarding and safety routes (campusconnect-ai integration).
import onboardingRoutes from './routes/onboarding.routes.js';
import safetyRoutes from './routes/safety.routes.js';
import chatRoutes from './routes/chat.routes.js';

// Initialize Express app
const app = express();
const PORT = process.env.PORT || 5001;

// Create HTTP server
const httpServer = createServer(app);

// Initialize Socket.io
const io = initializeSocket(httpServer);

// Make io accessible in routes
app.set('io', io);

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Test route
app.get('/', (req, res) => {
  res.json({
    message: '🎓 Welcome to CampusConnect API',
    status: 'running',
    version: '1.0.0',
    features: {
      rest: true,
      websockets: true,
      realtime: true,
    },
    timestamp: new Date().toISOString(),
  });
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({
    status: 'healthy',
    uptime: process.uptime(),
    socketConnections: io.engine.clientsCount,
    timestamp: new Date().toISOString(),
  });
});

// Test API endpoint
app.get('/api/test', (req, res) => {
  res.json({
    message: 'Backend API is working! ✅',
    features: [
      'GPS-based networking',
      'AI-powered matching',
      'Real-time chat with Socket.io',
    ],
  });
});

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/match', matchRoutes);
app.use('/api/connections', connectionsRoutes);
app.use('/api/ai-match', aiMatchRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/groups', groupsRoutes);
app.use('/api/events', eventsRoutes);
app.use('/api/help', helpRoutes);
app.use('/api/help/ai', helpAIRoutes);
// AI-driven onboarding and safety endpoints (students only).
app.use('/api/onboarding', onboardingRoutes);
app.use('/api/safety', safetyRoutes);
app.use('/api/chat', chatRoutes);

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    error: 'Route not found',
    path: req.path,
  });
});

// Error handler
app.use((err, req, res, next) => {
  console.error('Error:', err.stack);
  res.status(500).json({
    error: 'Something went wrong!',
    message: process.env.NODE_ENV === 'development' ? err.message : undefined,
  });
});

// Start server with Socket.io
httpServer.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════╗
║   🎓 CampusConnect Backend Server     ║
╚════════════════════════════════════════╝
  
  🚀 Server running on port ${PORT}
  🌍 HTTP: http://localhost:${PORT}
  🔌 WebSocket: ws://localhost:${PORT}
  📡 API: http://localhost:${PORT}/api
  
  Features:
  ✅ REST API
  ✅ WebSocket (Socket.io)
  ✅ Real-time communication
  
  Environment: ${process.env.NODE_ENV || 'development'}
  `);
});

