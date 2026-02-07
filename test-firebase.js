// Debug script for Firebase Admin credentials
import dotenv from 'dotenv';
import admin from 'firebase-admin';

dotenv.config();

console.log('=== Firebase Configuration Debug ===');
console.log('FIREBASE_PROJECT_ID:', process.env.FIREBASE_PROJECT_ID);
console.log('FIREBASE_CLIENT_EMAIL:', process.env.FIREBASE_CLIENT_EMAIL);
console.log('FIREBASE_PRIVATE_KEY length:', process.env.FIREBASE_PRIVATE_KEY?.length);
// Intentionally avoid logging any portion of the private key to protect secrets.

const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');
console.log('\n=== After Replace ===');
console.log('Private key length:', privateKey?.length);
console.log('Private key has actual newlines:', privateKey?.includes('\n'));

try {
  console.log('\n=== Initializing Firebase Admin ===');
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey,
    }),
  });
  console.log('✅ Firebase Admin initialized successfully');
  
  // Try to get auth
  const auth = admin.auth();
  console.log('✅ Auth service accessible');
  
  process.exit(0);
} catch (error) {
  console.error('❌ Error:', error.message);
  // Avoid logging the full error object to reduce the risk of leaking sensitive details.
  process.exit(1);
}
