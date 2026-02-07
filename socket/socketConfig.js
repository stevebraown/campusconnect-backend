import { Server } from 'socket.io';
import { verifyToken } from '../utils/jwt.js';
import { getConversationById, canAccessConversation } from '../services/chatService.js';

/**
 * Initialize Socket.io server
 * @param {Object} httpServer - HTTP server instance
 * @returns {Object} - Socket.io server instance
 */
export const initializeSocket = (httpServer) => {
  // Socket.io CORS configuration: mirror HTTP CORS and restrict browser origins.
  // This reduces the risk of unauthorized websites opening WebSocket sessions.
  const rawSocketOrigins = process.env.SOCKET_ORIGINS || process.env.CORS_ORIGINS;
  const defaultSocketOrigins = [
    'http://localhost:5173',
    'http://localhost:3000',
    'http://localhost:5001',
  ];
  const allowedSocketOrigins = rawSocketOrigins
    ? rawSocketOrigins.split(',').map((o) => o.trim()).filter(Boolean)
    : defaultSocketOrigins;

  const io = new Server(httpServer, {
    cors: {
      origin(origin, callback) {
        // Allow non-browser clients without an Origin header (e.g., native apps, CLI tools).
        if (!origin) {
          return callback(null, true);
        }
        if (allowedSocketOrigins.includes(origin)) {
          return callback(null, true);
        }
        return callback(new Error('Socket.io CORS: Origin not allowed by configuration'));
      },
      methods: ['GET', 'POST'],
      credentials: false,
    },
    pingTimeout: 60000,
    pingInterval: 25000,
  });

  console.log('🔌 Socket.io initialized');

  // Auth middleware: require valid JWT on connection
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) {
      return next(new Error('Authentication required'));
    }
    try {
      const decoded = verifyToken(token);
      socket.user = { uid: decoded.uid, email: decoded.email || '' };
      return next();
    } catch (err) {
      return next(new Error('Invalid or expired token'));
    }
  });

  // Track connected users
  const connectedUsers = new Map();
  const userSockets = new Map(); // userId -> Set(socketId)
  io.userSockets = userSockets;

  // Connection event
  io.on('connection', (socket) => {
    console.log(`✅ User connected: ${socket.id} (uid: ${socket.user?.uid || '?'})`);

    // Store user info - userId comes from JWT only, never from client
    socket.on('user:register', (userData) => {
      const userId = socket.user?.uid;
      if (!userId) {
        console.warn('user:register ignored: socket not authenticated');
        return;
      }
      connectedUsers.set(socket.id, {
        userId,
        username: userData?.username || socket.user?.email || 'User',
        status: 'online',
        connectedAt: new Date().toISOString(),
      });

      const set = userSockets.get(userId) || new Set();
      set.add(socket.id);
      userSockets.set(userId, set);

      console.log(`👤 User registered: ${userData?.username || userId} (${socket.id})`);

      // Broadcast user online status
      io.emit('user:status', {
        userId,
        status: 'online',
      });
    });

    // User typing event – use authenticated identity only
    socket.on('chat:typing', (data) => {
      const user = connectedUsers.get(socket.id);
      const userId = user?.userId ?? socket.user?.uid;
      if (!userId) return;
      socket.broadcast.emit('chat:user-typing', {
        userId,
        username: user?.username ?? socket.user?.email ?? 'User',
        isTyping: data?.isTyping ?? false,
      });
    });

    // Chat: join conversation room (for real-time message delivery) – uses JWT-derived identity
    socket.on('chat:join-conversation', async (data, callback) => {
      const user = connectedUsers.get(socket.id);
      const userId = user?.userId ?? socket.user?.uid;
      if (!userId) {
        if (typeof callback === 'function') callback({ ok: false, error: 'Not authenticated' });
        return;
      }
      const conversationId = data?.conversationId;
      if (!conversationId) {
        if (typeof callback === 'function') callback({ ok: false, error: 'conversationId required' });
        return;
      }
      try {
        const conversation = await getConversationById(conversationId);
        if (!conversation) {
          if (typeof callback === 'function') callback({ ok: false, error: 'Conversation not found' });
          return;
        }
        const allowed = await canAccessConversation(conversation, userId);
        if (!allowed) {
          if (typeof callback === 'function') callback({ ok: false, error: 'Access denied' });
          return;
        }
        const room = `conv:${conversationId}`;
        socket.join(room);
        if (typeof callback === 'function') callback({ ok: true, room });
      } catch (err) {
        console.error('chat:join-conversation error:', err);
        if (typeof callback === 'function') callback({ ok: false, error: 'Server error' });
      }
    });

    // Chat: leave conversation room
    socket.on('chat:leave-conversation', (data) => {
      const conversationId = data?.conversationId;
      if (conversationId) {
        socket.leave(`conv:${conversationId}`);
      }
    });

    // Send message event (legacy global chat) – use authenticated identity only
    socket.on('chat:send-message', (message) => {
      const user = connectedUsers.get(socket.id);
      const userId = user?.userId ?? socket.user?.uid;
      if (!userId) return;
      const content = typeof message?.text === 'string' ? message.text : '';
      if (!content.trim()) return;
      io.emit('chat:new-message', {
        id: Date.now(),
        userId,
        username: user?.username ?? socket.user?.email ?? 'User',
        text: content,
        timestamp: new Date().toISOString(),
      });
      console.log(`💬 Message from ${user?.username ?? userId}: ${content}`);
    });

    // Location update event (for GPS features) – uses user from JWT-derived registration
    socket.on('location:update', (locationData) => {
      const user = connectedUsers.get(socket.id);
      if (!user?.userId) return;
      user.location = locationData;
      socket.broadcast.emit('location:user-nearby', {
        userId: user.userId,
        username: user.username,
        location: locationData,
      });
    });

    // Event update (real-time event notifications) – inject source from authenticated user
    socket.on('event:update', (eventData) => {
      const userId = socket.user?.uid;
      io.emit('event:updated', {
        ...eventData,
        sourceUserId: userId ?? null,
      });
      console.log(`📅 Event updated: ${eventData?.eventId} (source: ${userId ?? '?'})`);
    });

    // Match notification – use authenticated identity; backend should emit via io.userSockets
    socket.on('match:new', (matchData) => {
      const userId = socket.user?.uid;
      if (!userId) return;
      io.emit('match:notification', {
        matchId: matchData?.matchId ?? null,
        userId,
        message: 'You have a new match!',
      });
    });

    // Disconnect event
    socket.on('disconnect', () => {
      const user = connectedUsers.get(socket.id);
      
      if (user) {
        console.log(`❌ User disconnected: ${user.username} (${socket.id})`);
        
        // Broadcast user offline status
        io.emit('user:status', {
          userId: user.userId,
          status: 'offline',
        });
        
        connectedUsers.delete(socket.id);
        // Remove socket mapping
        const set = userSockets.get(user.userId);
        if (set) {
          set.delete(socket.id);
          if (set.size === 0) userSockets.delete(user.userId);
        }
      } else {
        console.log(`❌ User disconnected: ${socket.id}`);
      }
    });

    // Error handling
    socket.on('error', (error) => {
      console.error('Socket error:', error);
    });
  });

  // Periodic stats logging
  setInterval(() => {
    console.log(`📊 Connected users: ${connectedUsers.size}`);
  }, 30000); // Every 30 seconds

  return io;
};

export default initializeSocket;
