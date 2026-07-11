'use strict';
const bcrypt  = require('bcryptjs');
const fs      = require('fs');
const path    = require('path');

const USERS_FILE  = path.join(__dirname, 'users.json');
const SALT_ROUNDS = 10;

class AuthManager {
  constructor() {
    this.users = [];
    this._load();
  }

  // ── persistence ────────────────────────────────────────────────────────────
  _load() {
    try {
      if (fs.existsSync(USERS_FILE)) {
        this.users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
        console.log(`✅ AuthManager: loaded ${this.users.length} user(s)`);
      } else {
        this._createDefaultAdmin();
      }
    } catch (e) {
      console.error('AuthManager: failed to load users.json:', e.message);
      this._createDefaultAdmin();
    }
    this._ensureSystemAccounts();
  }

  _save() {
    fs.writeFileSync(USERS_FILE, JSON.stringify(this.users, null, 2));
  }

  _createDefaultAdmin() {
    const hash = bcrypt.hashSync('Digitalpool', SALT_ROUNDS);
    this.users = [{
      username:            'admin',
      passwordHash:        hash,
      role:                'admin',
      forcePasswordChange: true,   // force change on first login
      createdAt:           new Date().toISOString(),
    }];
    this._save();
    console.log('✅ AuthManager: default admin created  →  admin / Digitalpool');
    console.log('⚠️  Please change the default password on first login.');
  }

  // ── Ensure built-in system accounts always exist ────────────────────────────
  _ensureSystemAccounts() {
    let changed = false;

    // ── Migration: admin created with locked:true should be unlocked so the
    //    operator can change the password.  Keep forcePasswordChange:true.
    const admin = this.findUser('admin');
    if (admin && admin.locked) {
      delete admin.locked;
      admin.forcePasswordChange = true;
      changed = true;
      console.log('✅ AuthManager: migrated admin — unlocked, forcePasswordChange set');
    }

    // ── dpadmin — support account; cannot be deleted but password may be
    //    overridden via DPADMIN_PASSWORD in .env (takes effect on restart).
    const dpPw   = process.env.DPADMIN_PASSWORD || 'Digitalpool42';
    const dpadmin = this.findUser('dpadmin');
    if (!dpadmin) {
      const hash = bcrypt.hashSync(dpPw, SALT_ROUNDS);
      this.users.push({
        username:            'dpadmin',
        passwordHash:        hash,
        role:                'admin',
        forcePasswordChange: false,
        locked:              true,   // cannot be deleted; password changeable via env or UI
        createdAt:           new Date().toISOString(),
      });
      changed = true;
      console.log('✅ AuthManager: dpadmin support account created');
    } else if (process.env.DPADMIN_PASSWORD && !bcrypt.compareSync(dpPw, dpadmin.passwordHash)) {
      // DPADMIN_PASSWORD is set and differs from the stored hash — update it.
      dpadmin.passwordHash = bcrypt.hashSync(dpPw, SALT_ROUNDS);
      changed = true;
      console.log('✅ AuthManager: dpadmin password updated from DPADMIN_PASSWORD env var');
    }

    if (changed) this._save();
  }

  // ── queries ─────────────────────────────────────────────────────────────────
  findUser(username) {
    return this.users.find(u => u.username === username.trim().toLowerCase());
  }

  listUsers() {
    return this.users.map(({ username, role, forcePasswordChange, locked, createdAt }) =>
      ({ username, role, forcePasswordChange, locked: !!locked, createdAt }));
  }

  // ── auth ────────────────────────────────────────────────────────────────────
  async verifyPassword(username, password) {
    const user = this.findUser(username);
    if (!user) return false;
    return bcrypt.compare(password, user.passwordHash);
  }

  // ── mutations ───────────────────────────────────────────────────────────────
  async addUser(username, password, role = 'operator') {
    username = username.trim().toLowerCase();
    if (!username || username.length < 2)
      throw new Error('Username must be at least 2 characters');
    if (!/^[a-z0-9_.-]+$/.test(username))
      throw new Error('Username may only contain letters, numbers, _ . -');
    if (this.findUser(username))
      throw new Error(`User "${username}" already exists`);
    if (!password || password.length < 8)
      throw new Error('Password must be at least 8 characters');
    if (!['admin', 'operator'].includes(role))
      throw new Error('Role must be "admin" or "operator"');

    const hash = await bcrypt.hash(password, SALT_ROUNDS);
    const user = {
      username,
      passwordHash:        hash,
      role,
      forcePasswordChange: false,
      createdAt:           new Date().toISOString(),
    };
    this.users.push(user);
    this._save();
    return { username, role, forcePasswordChange: false, createdAt: user.createdAt };
  }

  async changePassword(username, newPassword, requireOldPassword = null, oldPassword = null) {
    const user = this.findUser(username);
    if (!user) throw new Error('User not found');
    // locked only prevents deletion — password changes are allowed so operators
    // can rotate the dpadmin credential via the UI or DPADMIN_PASSWORD env var.
    if (requireOldPassword) {
      const ok = await bcrypt.compare(oldPassword, user.passwordHash);
      if (!ok) throw new Error('Current password is incorrect');
    }
    if (!newPassword || newPassword.length < 8)
      throw new Error('New password must be at least 8 characters');
    user.passwordHash        = await bcrypt.hash(newPassword, SALT_ROUNDS);
    user.forcePasswordChange = false;
    this._save();
  }

  deleteUser(username) {
    username = username.trim().toLowerCase();
    const idx = this.users.findIndex(u => u.username === username);
    if (idx === -1) throw new Error('User not found');
    if (this.users[idx].locked) throw new Error(`The "${username}" account is a built-in account and cannot be deleted`);
    if (username === 'admin') throw new Error('The built-in admin account cannot be deleted');
    // Prevent removing the last admin
    if (this.users[idx].role === 'admin') {
      const adminCount = this.users.filter(u => u.role === 'admin').length;
      if (adminCount <= 1) throw new Error('Cannot delete the last admin account');
    }
    this.users.splice(idx, 1);
    this._save();
  }

  updateRole(username, role) {
    username = username.trim().toLowerCase();
    if (!['admin', 'operator'].includes(role)) throw new Error('Invalid role');
    const user = this.findUser(username);
    if (!user) throw new Error('User not found');
    if (user.locked) throw new Error(`The "${username}" account is a built-in account and cannot be modified`);
    if (username === 'admin') throw new Error('The built-in admin account role cannot be changed');
    // Prevent downgrading the last admin
    if (user.role === 'admin' && role !== 'admin') {
      const adminCount = this.users.filter(u => u.role === 'admin').length;
      if (adminCount <= 1) throw new Error('Cannot downgrade the last admin account');
    }
    user.role = role;
    this._save();
  }
}

module.exports = new AuthManager();
