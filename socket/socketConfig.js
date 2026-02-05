import { Server } from 'socket.io';

/**
 * Initialize Socket.io server
 * @param {Object} httpServer - HTTP server instance
 * @returns {Object} - Socket.io server instance
 */
export const initializeSocket = (httpServer) => {
  const io = new Server(httpServer, {
    cors: {
      // Allow LAN access from any origin during local dev
      origin: '*',
      methods: ['GET', 'POST'],
      credentials: false,
    },
    pingTimeout: 60000,
    pingInterval: 25000,
  });

  console.log('🔌 Socket.io initialized');

  // Track connected users
  const connectedUsers = new Map();
  const userSockets = new Map(); // userId -> Set(socketId)
  io.userSockets = userSockets;

  // Connection event
  io.on('connection', (socket) => {
    console.log(`✅ User connected: ${socket.id}`);

    // Store user info
    socket.on('user:register', (userData) => {
      connectedUsers.set(socket.id, {
        userId: userData.userId,
        username: userData.username,
        status: 'online',
        connectedAt: new Date().toISOString(),
      });

      // Map userId to socket
      if (userData.userId) {
        const set = userSockets.get(userData.userId) || new Set();
        set.add(socket.id);
        userSockets.set(userData.userId, set);
      }
      
      console.log(`👤 User registered: ${userData.username} (${socket.id})`);
      
      // Broadcast user online status
      io.emit('user:status', {
        userId: userData.userId,
        status: 'online',
      });
    });

    // User typing event
    socket.on('chat:typing', (data) => {
      socket.broadcast.emit('chat:user-typing', {
        userId: data.userId,
        username: data.username,
        isTyping: data.isTyping,
      });
    });

    // Send message event
    socket.on('chat:send-message', (message) => {
      // Broadcast message to all users
      io.emit('chat:new-message', {
        id: Date.now(),
        userId: message.userId,
        username: message.username,
        text: message.text,
        timestamp: new Date().toISOString(),
      });
      
      console.log(`💬 Message from ${message.username}: ${message.text}`);
    });

    // Location update event (for GPS features)
    socket.on('location:update', (locationData) => {
      const user = connectedUsers.get(socket.id);
      if (user) {
        user.location = locationData;
        
        // Notify nearby users (placeholder logic)
        socket.broadcast.emit('location:user-nearby', {
          userId: user.userId,
          username: user.username,
          location: locationData,
        });
      }
    });

    // Event update (real-time event notifications)
    socket.on('event:update', (eventData) => {
      io.emit('event:updated', eventData);
      console.log(`📅 Event updated: ${eventData.eventId}`);
    });

    // Match notification
    socket.on('match:new', (matchData) => {
      // Send to specific user (in real implementation)
      io.emit('match:notification', {
        matchId: matchData.matchId,
        userId: matchData.userId,
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