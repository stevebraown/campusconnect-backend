// JWT signing and verification helpers
import jwt from 'jsonwebtoken';

const getSecret = () => process.env.JWT_SECRET;
const getExpiresIn = () => process.env.JWT_EXPIRES_IN || '7d';

export const signToken = (payload) => {
  const secret = getSecret();
  if (!secret) throw new Error('JWT_SECRET is missing');
  return jwt.sign(payload, secret, { expiresIn: getExpiresIn() });
};

export const verifyToken = (token) => {
  const secret = getSecret();
  if (!secret) throw new Error('JWT_SECRET is missing');
  return jwt.verify(token, secret);
};
