/**
 * Socket.io Event Handlers
 * Modular event handlers for different features
 */

/**
 * Chat handlers
 */
export const chatHandlers = (socket, io) => {
  socket.on('chat:join-room', (roomId) => {
    socket.join(roomId);
    console.log(`User ${socket.id} joined room ${roomId}`);
    
    io.to(roomId).emit('chat:user-joined', {
      socketId: socket.id,
      timestamp: new Date().toISOString(),
    });
  });

  socket.on('chat:leave-room', (roomId) => {
    socket.leave(roomId);
    console.log(`User ${socket.id} left room ${roomId}`);
    
    io.to(roomId).emit('chat:user-left', {
      socketId: socket.id,
      timestamp: new Date().toISOString(),
    });
  });

  socket.on('chat:send-room-message', ({ roomId, message }) => {
    io.to(roomId).emit('chat:room-message', {
      id: Date.now(),
      socketId: socket.id,
      message,
      timestamp: new Date().toISOString(),
    });
  });
};

/**
 * Presence handlers (online/offline status)
 */
export const presenceHandlers = (socket, io, connectedUsers) => {
  socket.on('presence:update-status', (status) => {
    const user = connectedUsers.get(socket.id);
    if (user) {
      user.status = status;
      io.emit('presence:status-changed', {
        userId: user.userId,
        status,
      });
    }
  });

  socket.on('presence:get-online-users', (callback) => {
    const onlineUsers = Array.from(connectedUsers.values())
      .filter(user => user.status === 'online')
      .map(user => ({
        userId: user.userId,
        username: user.username,
        status: user.status,
      }));
    
    callback(onlineUsers);
  });
};

/**
 * Event handlers (real-time event updates)
 */
export const eventHandlers = (socket, io) => {
  socket.on('event:subscribe', (eventId) => {
    socket.join(`event:${eventId}`);
    console.log(`User ${socket.id} subscribed to event ${eventId}`);
  });

  socket.on('event:unsubscribe', (eventId) => {
    socket.leave(`event:${eventId}`);
    console.log(`User ${socket.id} unsubscribed from event ${eventId}`);
  });

  socket.on('event:notify-attendees', ({ eventId, notification }) => {
    io.to(`event:${eventId}`).emit('event:notification', {
      eventId,
      notification,
      timestamp: new Date().toISOString(),
    });
  });
};

/**
 * Location handlers (GPS features)
 */
export const locationHandlers = (socket, io, connectedUsers) => {
  socket.on('location:share', (locationData) => {
    const user = connectedUsers.get(socket.id);
    if (user) {
      user.location = locationData;
      
      // Broadcast to users who are tracking this user
      socket.broadcast.emit('location:user-moved', {
        userId: user.userId,
        username: user.username,
        location: locationData,
      });
    }
  });

  socket.on('location:request-nearby', ({ lat, lng, radius }, callback) => {
    // Calculate nearby users (simplified version)
    const nearbyUsers = Array.from(connectedUsers.values())
      .filter(user => user.location && user.userId !== socket.userId)
      .map(user => ({
        userId: user.userId,
        username: user.username,
        location: user.location,
      }));
    
    callback(nearbyUsers);
  });
};

export default {
  chatHandlers,
  presenceHandlers,
  eventHandlers,
  locationHandlers,
};