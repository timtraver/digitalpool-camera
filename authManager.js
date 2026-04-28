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
      forcePasswordChange: true,
      createdAt:           new Date().toISOString(),
    }];
    this._save();
    console.log('✅ AuthManager: default admin created  →  admin / Digitalpool');
    console.log('⚠️  Please change the default password immediately after first login.');
  }

  // ── queries ─────────────────────────────────────────────────────────────────
  findUser(username) {
    return this.users.find(u => u.username === username.trim().toLowerCase());
  }

  listUsers() {
    return this.users.map(({ username, role, forcePasswordChange, createdAt }) =>
      ({ username, role, forcePasswordChange, createdAt }));
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
