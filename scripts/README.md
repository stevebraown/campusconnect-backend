# Backend Scripts

## resetAdminPasswords.js

Password reset script for admin accounts.

### Purpose

Resets passwords for admin accounts and ensures their roles are correct:
- Resets password for `admin@university.edu` and `superadmin@university.edu`
- Verifies both accounts have `role: 'admin'` in Firestore and custom claims
- Updates roles if needed

### Usage

**⚠️ IMPORTANT: Edit password constants in the script before running!**

1. Open `apps/backend/scripts/resetAdminPasswords.js`
2. Edit these constants at the top:
   ```javascript
   const NEW_ADMIN_PASSWORD = 'Admin2025!Reset';  // Change this!
   const NEW_SUPERADMIN_PASSWORD = 'SuperAdmin2025!Reset';  // Change this!
   ```
3. Run the script:
   ```bash
   # From repo root
   cd apps/backend
   node scripts/resetAdminPasswords.js
   
   # Or using npm script
   npm run reset-admin-passwords
   ```

### What It Does

For each admin email:
1. Looks up user by email using `getUserByEmail()`
2. Resets password using `updateUser(uid, { password })`
3. Verifies role is `'admin'` in Firestore and custom claims
4. Updates both if needed using `syncRoleToAllSources()`
5. Logs all changes

### Output

Example output:
```
👤 Processing: admin@university.edu
✅ Password reset successful (UID: abc123)
✅ Role already correct (admin)

👤 Processing: superadmin@university.edu
✅ Password reset successful (UID: def456)
✅ Role updated:
   - Firestore: user → admin
   - Custom claims: none → admin

📊 SUMMARY
✅ admin@university.edu (abc123)
   Password: Reset successfully
   Role: admin (already correct)

✅ superadmin@university.edu (def456)
   Password: Reset successfully
   Role: admin (updated)
```

### Security

- **Local-only script** - Not exposed as HTTP endpoint
- **Requires Firebase Admin credentials** - Only run on secure servers
- **Change passwords after first use** - Script uses placeholder passwords

### When to Use

- Initial admin account setup
- After admin account creation
- When admin passwords are lost/forgotten
- To ensure admin roles are correct

---

## repairRoles.js

One-time role repair mechanism that enforces consistency across all users.

### Purpose

Scans all users in Firebase Auth and Firestore, then enforces role consistency:
- Reads role from Firestore (source of truth if exists)
- Falls back to `ADMIN_EMAILS` check if Firestore doesn't exist
- Updates both Firestore and custom claims to match the resolved role
- JWT will naturally follow on next login

### Usage

```bash
# From repo root
node apps/backend/scripts/repairRoles.js

# Or from backend directory
cd apps/backend
node scripts/repairRoles.js
```

### What It Does

For each user:
1. Reads current role from Firestore
2. Reads current role from custom claims
3. Resolves expected role using source of truth logic:
   - **Priority:** Firestore (if exists) > `ADMIN_EMAILS` > 'user'
4. Updates Firestore if role doesn't match
5. Updates custom claims if role doesn't match
6. Logs all changes

### Output

The script logs:
- Per-user: previous Firestore role, previous claim role, new enforced role
- Summary: total users, repaired count, unchanged count, errors

Example output:
```
👤 Processing: superadmin@university.edu (abc123)
  ✅ Repaired:
     - Firestore: user → admin
     - Claims: user → admin

📊 REPAIR SUMMARY
============================================================
Total users:     10
Repaired:        2
Unchanged:       8
Errors:          0
============================================================
```

### When to Run

- After initial setup
- After bulk role changes
- When role inconsistencies are detected
- After adding emails to `ADMIN_EMAILS` env var

### Important Notes

- **Not exposed as HTTP endpoint** - This is a local script only
- **Safe to run multiple times** - It only updates if roles don't match
- **Users get updated JWT on next login** - The script updates Firestore and custom claims, but users need to log out/in to get a new JWT

### Source of Truth

The script uses the same role resolution logic as `/api/auth/login` and `/api/auth/register`:
- **Firestore `users/{uid}.role`** is the source of truth if it exists
- **`ADMIN_EMAILS` env var** is used if Firestore doc doesn't exist
- Both sources are synced to ensure consistency
