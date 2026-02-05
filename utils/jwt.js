// JWT signing and verification helpers
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';

if (!JWT_SECRET) {
  console.warn('[warn] JWT_SECRET is not set. Set it in your environment for security.');
}

export const signToken = (payload) => {
  if (!JWT_SECRET) throw new Error('JWT_SECRET is missing');
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
};

export const verifyToken = (token) => {
  if (!JWT_SECRET) throw new Error('JWT_SECRET is missing');
  return jwt.verify(token, JWT_SECRET);
};
