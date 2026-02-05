# Backend API Server

## Environment
- `PORT` (optional, default 5001)
- `FIREBASE_PROJECT_ID`
- `FIREBASE_CLIENT_EMAIL`
- `FIREBASE_PRIVATE_KEY` (escape newlines as `\n`)
- `FIREBASE_API_KEY` (Firebase Web API key for email/password auth)
- `JWT_SECRET`
- `JWT_EXPIRES_IN` (optional, default `7d`)
- `ADMIN_EMAILS` (comma-separated list to auto-assign admin role)

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
- Firestore access should be enforced with the rules in `docs/backend/FIRESTORE_SCHEMA.md`.
- JWTs are signed with `JWT_SECRET`; set it in your environment.
