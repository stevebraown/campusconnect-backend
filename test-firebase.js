// Debug script for Firebase Admin credentials
import dotenv from 'dotenv';
import admin from 'firebase-admin';

dotenv.config();

console.log('=== Firebase Configuration Debug ===');
console.log('FIREBASE_PROJECT_ID:', process.env.FIREBASE_PROJECT_ID);
console.log('FIREBASE_CLIENT_EMAIL:', process.env.FIREBASE_CLIENT_EMAIL);
console.log('FIREBASE_PRIVATE_KEY length:', process.env.FIREBASE_PRIVATE_KEY?.length);
console.log('FIREBASE_PRIVATE_KEY first 50 chars:', process.env.FIREBASE_PRIVATE_KEY?.substring(0, 50));
console.log('FIREBASE_PRIVATE_KEY last 50 chars:', process.env.FIREBASE_PRIVATE_KEY?.substring(process.env.FIREBASE_PRIVATE_KEY.length - 50));

const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');
console.log('\n=== After Replace ===');
console.log('Private key length:', privateKey?.length);
console.log('Private key first 50 chars:', privateKey?.substring(0, 50));
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
  console.error('Full error:', error);
  process.exit(1);
}
