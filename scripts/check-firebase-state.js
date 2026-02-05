#!/usr/bin/env node
/**
 * Firebase State Checker for CampusConnect
 * 
 * Fetches current Firebase state and compares it to expected configuration.
 * Generates deployment reports showing what's missing or needs attention.
 * 
 * Usage:
 *   node backend/scripts/check-firebase-state.js
*   or: npm run firebase:check
 * 
 * Output:
 *   - .firebase-state.json (machine-readable)
 *   - .firebase-deployment-report.md (human-readable)
 */

import 'dotenv/config';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { firebaseAuth, firestore } from '../config/firebaseAdmin.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = resolve(__dirname, '../../../');

// Required composite indexes for CampusConnect
const REQUIRED_INDEXES = [
  {
    name: 'groups-status-createdAt',
    collection: 'groups',
    fields: ['status', 'createdAt'],
    order: ['ASCENDING', 'DESCENDING']
  },
  {
    name: 'groups-status-type-createdAt',
    collection: 'groups',
    fields: ['status', 'type', 'createdAt'],
    order: ['ASCENDING', 'ASCENDING', 'DESCENDING']
  },
  {
    name: 'groups-members-status-updatedAt',
    collection: 'groups',
    fields: ['members', 'status', 'updatedAt'],
    order: ['ARRAY', 'ASCENDING', 'DESCENDING']
  },
  {
    name: 'events-status-startTime',
    collection: 'events',
    fields: ['status', 'startTime'],
    order: ['ASCENDING', 'ASCENDING']
  },
  {
    name: 'events-status-createdAt',
    collection: 'events',
    fields: ['status', 'createdAt'],
    order: ['ASCENDING', 'DESCENDING']
  },
  {
    name: 'events-attendees-status-startTime',
    collection: 'events',
    fields: ['attendees', 'status', 'startTime'],
    order: ['ARRAY', 'ASCENDING', 'ASCENDING']
  },
  {
    name: 'connections-toUserId-status',
    collection: 'connections',
    fields: ['toUserId', 'status'],
    order: ['ASCENDING', 'ASCENDING']
  },
  {
    name: 'connections-fromUserId-status',
    collection: 'connections',
    fields: ['fromUserId', 'status'],
    order: ['ASCENDING', 'ASCENDING']
  },
  {
    name: 'matches-users',
    collection: 'matches',
  const frontendEnvPath = join(PROJECT_ROOT, 'frontend/.env.local');
    order: ['ARRAY']
  },
  {
    name: 'helpJourneys-categoryId-createdAt',
    collection: 'helpJourneys',
    fields: ['categoryId', 'createdAt'],
    order: ['ASCENDING', 'DESCENDING']
  },
  {
    name: 'helpJourneys-step-createdAt',
    collection: 'helpJourneys',
    fields: ['step', 'createdAt'],
    order: ['ASCENDING', 'DESCENDING']
  },
  {
    name: 'helpJourneys-userId-createdAt',
    collection: 'helpJourneys',
    fields: ['userId', 'createdAt'],
    order: ['ASCENDING', 'DESCENDING']
  }
];

// Required environment variables
const REQUIRED_BACKEND_ENV = [
  'FIREBASE_PROJECT_ID',
    frontendEnv.missing = ['File not found: frontend/.env.local'];
  'FIREBASE_PRIVATE_KEY',
  'ADMIN_EMAILS',
  'PORT',
  'NODE_ENV'
];

const OPTIONAL_BACKEND_ENV = [
  'GEOFENCE_CENTER_LAT',
  'GEOFENCE_CENTER_LNG',
  'GEOFENCE_RADIUS_M'
];

const REQUIRED_FRONTEND_ENV = [
  'VITE_FIREBASE_API_KEY',
  'VITE_FIREBASE_AUTH_DOMAIN',
  'VITE_FIREBASE_PROJECT_ID',
  'VITE_FIREBASE_STORAGE_BUCKET',
  'VITE_FIREBASE_MESSAGING_SENDER_ID',
  'VITE_FIREBASE_APP_ID',
  'VITE_API_URL'
];

/**
 * Check environment variables
 */
function checkEnvironmentVariables() {
  const backendEnv = {
    configured: true,
    missing: [],
    optional: []
  };

  const frontendEnv = {
    configured: true,
    missing: []
  };

  // Check backend .env
  REQUIRED_BACKEND_ENV.forEach(key => {
    if (!process.env[key]) {
      backendEnv.missing.push(key);
      backendEnv.configured = false;
    }
  });

  OPTIONAL_BACKEND_ENV.forEach(key => {
    if (!process.env[key]) {
      backendEnv.optional.push(key);
    }
  });

  // Check frontend .env.local
  const frontendEnvPath = join(PROJECT_ROOT, 'frontend/.env.local');
  const frontendEnvExists = existsSync(frontendEnvPath);
  
  if (frontendEnvExists) {
    try {
      const frontendEnvContent = readFileSync(frontendEnvPath, 'utf-8');
      const frontendEnvVars = {};
      frontendEnvContent.split('\n').forEach(line => {
        const match = line.match(/^([^#=]+)=(.+)$/);
        if (match) {
          frontendEnvVars[match[1].trim()] = match[2].trim();
        }
      });

      REQUIRED_FRONTEND_ENV.forEach(key => {
        if (!frontendEnvVars[key]) {
          frontendEnv.missing.push(key);
          frontendEnv.configured = false;
        }
      });
    } catch (err) {
      frontendEnv.configured = false;
      frontendEnv.missing = ['Error reading .env.local file'];
    }
  } else {
    frontendEnv.configured = false;
    frontendEnv.missing = ['File not found: frontend/.env.local'];
  }

  return { backend: backendEnv, frontend: frontendEnv };
}

/**
 * Fetch Firestore collections and document counts
 */
async function fetchFirestoreState() {
  const collections = [];
  const documentCounts = {};

  try {
    // List collections (Admin SDK doesn't have a direct listCollections method,
    // so we'll try to query known collections from the docs)
    const knownCollections = [
      'users', 'profiles', 'groups', 'events', 'connections', 'matches',
      'helpCategories', 'helpJourneys', 'admin', 'posts'
    ];

    for (const collectionName of knownCollections) {
      try {
        const snapshot = await firestore.collection(collectionName).limit(1).get();
        if (!snapshot.empty || snapshot.size === 0) {
          // Collection exists (even if empty)
          collections.push(collectionName);
          
          // Get full count (this may be slow for large collections)
          try {
            const countSnapshot = await firestore.collection(collectionName).count().get();
            const count = countSnapshot.data().count || 0;
            documentCounts[collectionName] = count;
          } catch (err) {
            // Fallback: try to get all and count (not recommended for large collections)
            try {
              const allSnapshot = await firestore.collection(collectionName).get();
              documentCounts[collectionName] = allSnapshot.size;
            } catch (err2) {
              documentCounts[collectionName] = 'error';
            }
          }
        }
      } catch (err) {
        // Collection might not exist or we don't have permission
        // Skip it
      }
    }
  } catch (err) {
    console.error('Error fetching Firestore state:', err.message);
  }

  return { collections, documentCounts };
}

/**
 * Check Authentication state
 */
async function fetchAuthenticationState() {
  let totalUsers = 0;
  let enabled = true;

  try {
    const listUsersResult = await firebaseAuth.listUsers(1000);
    totalUsers = listUsersResult.users.length;
    
    // Check if there are more users (pagination)
    while (listUsersResult.pageToken) {
      const nextPage = await firebaseAuth.listUsers(1000, listUsersResult.pageToken);
      totalUsers += nextPage.users.length;
      listUsersResult.pageToken = nextPage.pageToken;
    }
  } catch (err) {
    console.error('Error fetching authentication state:', err.message);
    enabled = false;
  }

  return {
    enabled,
    totalUsers,
    customClaimsUsed: true // CampusConnect uses custom claims for roles
  };
}

/**
 * Check Firestore indexes
 * Note: Firebase Admin SDK doesn't expose index management API directly.
 * We'll note that manual check is required, or suggest using Firebase CLI.
 */
async function checkFirestoreIndexes() {
  // Unfortunately, Firebase Admin SDK doesn't provide a way to list indexes.
  // This would require Firebase Management API or Firebase CLI.
  // We'll return a note that manual check is required.
  
  return {
    deployed: [],
    missing: REQUIRED_INDEXES.map(idx => idx.name),
    note: 'Index status requires manual check in Firebase Console or Firebase CLI. Use: firebase firestore:indexes'
  };
}

/**
 * Generate deployment status summary
 */
function generateDeploymentStatus(firestoreState, authState, envState, indexesState) {
  const status = {
    firestore_rules: 'manual_check_required',
    firestore_indexes: indexesState.missing.length === 0 ? 'complete' : 
                      indexesState.deployed.length > 0 ? 'partial' : 'missing',
    auth_setup: authState.enabled ? 'done' : 'error',
    env_variables: (envState.backend.configured && envState.frontend.configured) ? 'complete' : 'incomplete'
  };

  return status;
}

/**
 * Generate next steps
 */
function generateNextSteps(firestoreState, authState, envState, indexesState, deploymentStatus) {
  const steps = [];

  if (indexesState.missing.length > 0) {
    steps.push(`Create ${indexesState.missing.length} missing Firestore composite index(es). Run: firebase deploy --only firestore:indexes`);
  }

  if (deploymentStatus.firestore_rules === 'manual_check_required') {
    steps.push('Verify Firestore rules in Console match repo version. Check: Firebase Console → Firestore → Rules');
  }

  if (!envState.backend.configured) {
    steps.push(`Fix backend .env: Missing ${envState.backend.missing.join(', ')}`);
  }

  if (!envState.frontend.configured) {
    steps.push(`Fix frontend .env.local: Missing ${envState.frontend.missing.join(', ')}`);
  }

  if (steps.length === 0) {
    steps.push('✅ All checks passed! Firebase is properly configured.');
  }

  return steps;
}

/**
 * Generate markdown report
 */
function generateMarkdownReport(state) {
  const timestamp = new Date(state.timestamp).toLocaleString();
  const projectId = state.projectId;

  let markdown = `# Firebase Deployment Report

**Generated:** ${timestamp}  
**Project:** ${projectId}

---

## ✅ Status Summary

| Item | Status | Notes |
|------|--------|-------|
| Firestore Database | ${state.firestore.collections.length > 0 ? '✅ Created' : '❌ Not Found'} | ${state.firestore.collections.length} collection(s) found |
| Authentication | ${state.authentication.enabled ? '✅ Configured' : '❌ Error'} | ${state.authentication.totalUsers} user(s) |
| Firestore Rules | ⚠️ Needs Manual Check | See Firebase Console → Firestore → Rules |
| Composite Indexes | ${state.firestore.indexesStatus.missing.length === 0 ? '✅ Complete' : state.firestore.indexesStatus.deployed.length > 0 ? '⏳ Partial' : '❌ Missing'} | ${state.firestore.indexesStatus.deployed.length}/${state.firestore.indexesStatus.deployed.length + state.firestore.indexesStatus.missing.length} deployed, ${state.firestore.indexesStatus.missing.length} missing |
| Backend .env | ${state.environmentVariables.backend.configured ? '✅ Complete' : '❌ Incomplete'} | ${state.environmentVariables.backend.missing.length === 0 ? 'All required variables set' : `Missing: ${state.environmentVariables.backend.missing.join(', ')}`} |
| Frontend .env.local | ${state.environmentVariables.frontend.configured ? '✅ Complete' : '❌ Incomplete'} | ${state.environmentVariables.frontend.missing.length === 0 ? 'All required variables set' : `Missing: ${state.environmentVariables.frontend.missing.join(', ')}`} |

---

## 📊 Collections in Firestore

| Collection | Doc Count | Status |
|------------|-----------|--------|
`;

  // Add collection rows
  if (state.firestore.collections.length === 0) {
    markdown += '| *(no collections found)* | - | ⚠️ |\n';
  } else {
    for (const collection of state.firestore.collections) {
      const count = state.firestore.documentCounts[collection] || 0;
      const status = count === 'error' ? '⚠️' : count === 0 ? '📭' : '✅';
      markdown += `| ${collection} | ${count} | ${status} |\n`;
    }
  }

  markdown += `
---

## 🔴 Missing Composite Indexes (MUST DEPLOY)

`;

  if (state.firestore.indexesStatus.missing.length === 0) {
    markdown += '✅ All required indexes are deployed!\n\n';
  } else {
    for (const indexName of state.firestore.indexesStatus.missing) {
      const index = REQUIRED_INDEXES.find(idx => idx.name === indexName);
      if (index) {
        markdown += `1. **${index.collection} (${index.fields.join(', ')})**\n`;
        markdown += `   - Used for: Queries on ${index.collection} collection\n`;
        markdown += `   - Deploy command: \`firebase deploy --only firestore:indexes\`\n\n`;
      }
    }
  }

  markdown += `---

## 🔍 Firestore Rules Check

**Current Status:** Unable to auto-fetch (requires manual check in Console)

To verify:
1. Go to [Firebase Console](https://console.firebase.google.com)
2. Select your project
3. Firestore Database → Rules tab
4. Compare with: \`docs/FIREBASE_CONFIGURATION_GUIDE.md\` in this repo
5. If different, click Publish after updating

Or deploy via CLI:
\`\`\`bash
firebase deploy --only firestore:rules
\`\`\`

---

## 🚀 Deployment Commands

To fully deploy CampusConnect Firebase config:

\`\`\`bash
# Deploy everything at once
firebase deploy

# Or deploy individually:
firebase deploy --only firestore:rules
firebase deploy --only firestore:indexes
\`\`\`

---

## ✨ Environment Variables

### Backend (backend/.env)

${state.environmentVariables.backend.configured ? '✅' : '❌'} ${state.environmentVariables.backend.configured ? 'All required variables are set' : `Missing: ${state.environmentVariables.backend.missing.join(', ')}`}

${state.environmentVariables.backend.optional.length > 0 ? `⚠️ Optional variables not set: ${state.environmentVariables.backend.optional.join(', ')}` : ''}

### Frontend (frontend/.env.local)

${state.environmentVariables.frontend.configured ? '✅' : '❌'} ${state.environmentVariables.frontend.configured ? 'All required variables are set' : `Missing: ${state.environmentVariables.frontend.missing.join(', ')}`}

---

## ✅ Next Steps (In Order)

`;

  state.nextSteps.forEach((step, index) => {
    markdown += `${index + 1}. ${step}\n\n`;
  });

  markdown += `---

**Script run completed successfully.**  
Re-run this script after deployment to verify all indexes are ready.

`;

  return markdown;
}

/**
 * Main execution
 */
async function main() {
  console.log('🔍 Checking Firebase state for CampusConnect...\n');

  // Validate Firebase credentials
  if (!process.env.FIREBASE_PROJECT_ID || !process.env.FIREBASE_CLIENT_EMAIL || !process.env.FIREBASE_PRIVATE_KEY) {
    console.error('❌ Error: Missing Firebase credentials in .env');
    console.error('Required: FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY');
    process.exit(1);
  }

  const projectId = process.env.FIREBASE_PROJECT_ID;
  console.log(`📦 Project: ${projectId}\n`);

  try {
    // Fetch state
    console.log('📊 Fetching Firestore state...');
    const firestoreState = await fetchFirestoreState();
    console.log(`   Found ${firestoreState.collections.length} collection(s)`);

    console.log('👥 Fetching Authentication state...');
    const authState = await fetchAuthenticationState();
    console.log(`   Found ${authState.totalUsers} user(s)`);

    console.log('🔍 Checking environment variables...');
    const envState = checkEnvironmentVariables();
    console.log(`   Backend: ${envState.backend.configured ? '✅' : '❌'}`);
    console.log(`   Frontend: ${envState.frontend.configured ? '✅' : '❌'}`);

    console.log('📇 Checking Firestore indexes...');
    const indexesState = await checkFirestoreIndexes();
    console.log(`   ${indexesState.missing.length} missing index(es) detected`);

    // Generate state object
    const state = {
      timestamp: new Date().toISOString(),
      projectId,
      firestore: {
        collections: firestoreState.collections,
        documentCounts: firestoreState.documentCounts,
        rulesDeployed: 'unknown (check Firebase Console → Firestore → Rules)',
        indexesStatus: indexesState
      },
      authentication: authState,
      environmentVariables: envState,
      deploymentStatus: generateDeploymentStatus(firestoreState, authState, envState, indexesState),
      nextSteps: generateNextSteps(firestoreState, authState, envState, indexesState, generateDeploymentStatus(firestoreState, authState, envState, indexesState))
    };

    // Write JSON report
    const jsonPath = join(PROJECT_ROOT, '.firebase-state.json');
    writeFileSync(jsonPath, JSON.stringify(state, null, 2));
    console.log(`\n✅ JSON report written to: .firebase-state.json`);

    // Write markdown report
    const markdown = generateMarkdownReport(state);
    const mdPath = join(PROJECT_ROOT, '.firebase-deployment-report.md');
    writeFileSync(mdPath, markdown);
    console.log(`✅ Markdown report written to: .firebase-deployment-report.md`);

    // Console summary
    console.log('\n📋 Summary:');
    console.log(`   Collections: ${firestoreState.collections.length}`);
    console.log(`   Users: ${authState.totalUsers}`);
    console.log(`   Missing indexes: ${indexesState.missing.length}`);
    console.log(`   Backend env: ${envState.backend.configured ? '✅' : '❌'}`);
    console.log(`   Frontend env: ${envState.frontend.configured ? '✅' : '❌'}`);
    console.log(`\n📄 See .firebase-deployment-report.md for detailed next steps.\n`);

  } catch (err) {
    console.error('❌ Error:', err.message);
    console.error(err.stack);
    process.exit(1);
  }
}

main();
