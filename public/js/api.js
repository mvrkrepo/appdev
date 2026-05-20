'use strict';

const API = {
  async request(method, path, body, isMultipart) {
    const token = localStorage.getItem('auth_token');
    const headers = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;
    if (body && !isMultipart) headers['Content-Type'] = 'application/json';

    const opts = { method, headers };
    if (body && !isMultipart) opts.body = JSON.stringify(body);
    if (body && isMultipart) opts.body = body;

    const resp = await fetch(path, opts);

    if (resp.status === 401) {
      localStorage.removeItem('auth_token');
      localStorage.removeItem('auth_user');
      window.location.href = '/';
      return;
    }

    const ct = resp.headers.get('content-type') || '';
    if (ct.includes('application/pdf')) return resp;

    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(data.error || `Request failed (${resp.status})`);
    return data;
  },

  get(path)            { return this.request('GET',    path); },
  post(path, body)     { return this.request('POST',   path, body); },
  put(path, body)      { return this.request('PUT',    path, body); },
  del(path)            { return this.request('DELETE', path); },
  upload(path, form)   { return this.request('POST',   path, form, true); },

  getUser()  { try { return JSON.parse(localStorage.getItem('auth_user')); } catch { return null; } },
  getToken() { return localStorage.getItem('auth_token'); },

  requireAuth(requiredRole) {
    const user = this.getUser();
    const token = this.getToken();
    if (!user || !token) { window.location.href = '/'; return null; }
    if (requiredRole && user.role !== requiredRole) {
      window.location.href = user.role === 'inspector'
        ? '/inspector/dashboard.html'
        : '/insurance/dashboard.html';
      return null;
    }
    return user;
  },

  logout() {
    localStorage.removeItem('auth_token');
    localStorage.removeItem('auth_user');
    window.location.href = '/';
  }
};

// Toast notifications
function toast(message, type = 'info') {
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    document.body.appendChild(container);
  }
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

// Badge HTML helper
function statusBadge(status) {
  const labels = {
    draft: 'Draft',
    submitted: 'Submitted',
    under_review: 'Under Review',
    approved: 'Approved',
    rejected: 'Rejected'
  };
  return `<span class="badge badge-${status}">${labels[status] || status}</span>`;
}

// Score ring helper
function scoreRing(score, maxScore) {
  if (!maxScore) return `<span class="score-ring na">N/A</span>`;
  const pct = Math.round((score / maxScore) * 100);
  const cls = pct >= 80 ? 'high' : pct >= 60 ? 'mid' : 'low';
  return `<span class="score-ring ${cls}">${pct}%</span>`;
}

// Populate sidebar user info
function populateSidebar(user) {
  const el = document.getElementById('sidebarUserName');
  const el2 = document.getElementById('sidebarUserRole');
  const av = document.getElementById('sidebarAvatar');
  if (el) el.textContent = user.name;
  if (el2) el2.textContent = user.role === 'insurance' ? 'Insurance Provider' : 'Site Inspector';
  if (av) av.textContent = user.name.split(' ').map(p => p[0]).join('').substring(0, 2).toUpperCase();
}
