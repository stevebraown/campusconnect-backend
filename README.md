# CampusConnect Backend API Server

Express.js API and Socket.io server for CampusConnect. Handles auth (Firebase + JWT), user profiles, matching, groups, events, and real-time features.

## Setup

```bash
npm install
cp .env.example .env
# Edit .env with your Firebase, JWT, and optional AI/Perplexity values.
```

## Run locally

```bash
npm run dev
```

Server runs at `http://localhost:5001` (or `PORT` from `.env`). Health: `GET /api/health`.

## Docker

Build and run (standalone repo; build context is this directory):

```bash
docker build -t campusconnect-backend .
docker run -p 5001:5001 --env-file .env campusconnect-backend
```

Exposed port: `5001`. Override with `-e PORT=8080` and `-p 8080:8080` if needed.

## Environment variables

Copy `.env.example` to `.env` and set:

- `PORT` (optional, default 5001)
- `NODE_ENV` (optional, e.g. `development` or `production`)
- `FIREBASE_PROJECT_ID`
- `FIREBASE_CLIENT_EMAIL`
- `FIREBASE_PRIVATE_KEY` (escape newlines as `\n`)
- `FIREBASE_API_KEY` (Firebase Web API key for email/password auth)
- `JWT_SECRET`
- `JWT_EXPIRES_IN` (optional, default `7d`)
- `ADMIN_EMAILS` (comma-separated list to auto-assign admin role)
- `AI_SERVICE_URL`, `AI_SERVICE_TOKEN` (optional; CampusConnect AI service)
- See `.env.example` for optional Perplexity and geofence vars.

## Auth Flow
1) Frontend sends email/password to `/api/auth/register` or `/api/auth/login`.
2) Backend uses Firebase Identity Toolkit to verify credentials, resolves role (admin if email in `ADMIN_EMAILS`), syncs Firestore docs/claims, and returns a backend JWT `{ uid, email, role }`.
3) Client stores the JWT and sends `Authorization: Bearer <token>` on protected routes.

## Key Endpoints
- `POST /api/auth/register` – accepts `{ email, password, name? }`, returns `{ success, token, user }`
- `POST /api/auth/login` – accepts `{ email, password }`, returns `{ success, token, user }`
- `POST /api/auth/logout` – returns `{ success: true }`
- `POST /api/auth/forgot-password` – accepts `{ email }`, returns `{ success: true }`
- `GET /api/auth/me` – requires JWT, returns `{ success, user }`
- `GET /api/users/me` – requires JWT, returns `{ success, user, profile }`
- `GET /api/users/:uid/profile` – requires JWT, returns `{ success, profile }`

## Security

- Firestore access is enforced with the rules in `firestore.rules`. Deploy with `firebase deploy --only firestore:rules`.
- JWTs are signed with `JWT_SECRET`; set it in your environment and keep `.env` out of version control.
