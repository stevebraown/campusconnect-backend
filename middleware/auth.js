// Auth middleware for JWT validation and role checks
import { verifyToken } from '../utils/jwt.js';
import { getAccount } from '../lib/user-helpers.js';

export const requireAuth = async (req, res, next) => {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }

  try {
    const decoded = verifyToken(token);
    const { uid, email } = decoded;

    // Get account from correct collection (admin or user)
    const account = await getAccount(uid);
    if (!account) {
      return res.status(404).json({ success: false, error: 'Account not found' });
    }

    // Check if disabled
    if (account.data.disabled) {
      return res.status(403).json({
        success: false,
        error: 'Account disabled. Deletion pending admin review.'
      });
    }

    // Attach user info to request
    req.user = {
      uid,
      email: account.data.email,
      isAdmin: account.type === 'admin',
      accountType: account.type, // 'admin' or 'user'
      data: account.data, // Full account data
      role: account.type === 'admin' ? 'admin' : (account.data.role || 'user'), // Legacy role for compatibility
    };

    return next();
  } catch (err) {
    console.error('Auth error:', err.message);
    return res.status(401).json({ success: false, error: 'Invalid or expired token' });
  }
};

export const requireAdmin = (req, res, next) => {
  if (req.user?.isAdmin) return next();
  return res.status(403).json({ success: false, error: 'Admin only' });
};

export const requireOwnership = (param = 'id') => (req, res, next) => {
  if (req.user?.role === 'admin') return next();
  if (req.user?.uid === req.params[param]) return next();
  return res.status(403).json({ success: false, error: 'Forbidden' });
};
