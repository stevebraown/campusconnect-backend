# Chat API

Messaging endpoints for community and private chats. All endpoints require `Authorization: Bearer <JWT>`.

## Endpoints

### List conversations
```
GET /api/chat/conversations?limit=50&offset=0
```
Returns conversations for the authenticated user (community + private), sorted by last activity.

**Response:** `{ success, conversations, total, limit, offset }`

### Create conversation
```
POST /api/chat/conversations
Body: { type: 'private', participantIds: ['uid1','uid2'] }
   or { type: 'community', communityId: 'groupId' }
```
Creates a new 1:1, group, or community conversation. For private chats, all participants must be accepted connections.

### Get conversation
```
GET /api/chat/conversations/:id
```

### Get messages
```
GET /api/chat/conversations/:id/messages?limit=50&before=msgId
```

### Send message
```
POST /api/chat/conversations/:id/messages
Body: { content: string }
```

### Get by community
```
GET /api/chat/conversations/by-community/:communityId
```
Gets or creates the community chat. User must be a member.

### Get by user
```
GET /api/chat/conversations/by-user/:userId
```
Gets or creates a 1:1 conversation with a connection.

### Mark as read (optional)
```
POST /api/chat/conversations/:id/read
```

## Real-time (Socket.io)

- **Join room:** Emit `chat:join-conversation` with `{ conversationId }`. Callback receives `{ ok, error?, room? }`.
- **Leave room:** Emit `chat:leave-conversation` with `{ conversationId }`.
- **New message:** Listen for `chat:new-message`. Payload: `{ id, conversationId, senderId, senderName, content, createdAt }`.

## Permissions

- **Private:** Only participants (accepted connections) can access.
- **Community:** Only community members can access.
- Messages are persisted and broadcast to room participants only.
