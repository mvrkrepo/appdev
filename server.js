'use strict';

const express = require('express');
const Database = require('better-sqlite3');
const multer = require('multer');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const PDFDocument = require('pdfkit');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'si-app-jwt-secret-changeme';

['database', 'uploads'].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

const db = new Database('./database/safety.db');
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    name TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('inspector', 'insurance')),
    company TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS inspections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    inspector_id INTEGER NOT NULL,
    site_name TEXT NOT NULL,
    site_address TEXT NOT NULL,
    site_type TEXT,
    inspection_date TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft',
    score INTEGER DEFAULT 0,
    max_score INTEGER DEFAULT 0,
    notes TEXT,
    insurance_notes TEXT,
    submitted_at DATETIME,
    reviewed_at DATETIME,
    reviewed_by INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (inspector_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS inspection_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    inspection_id INTEGER NOT NULL,
    category TEXT NOT NULL,
    item_name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'na' CHECK(status IN ('compliant', 'non_compliant', 'na')),
    notes TEXT,
    FOREIGN KEY (inspection_id) REFERENCES inspections(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS inspection_photos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    inspection_id INTEGER NOT NULL,
    filename TEXT NOT NULL,
    original_name TEXT NOT NULL,
    caption TEXT,
    uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (inspection_id) REFERENCES inspections(id) ON DELETE CASCADE
  );
`);

const CHECKLIST = [
  {
    category: 'Fire Safety',
    items: [
      'Fire extinguishers present and accessible',
      'Fire extinguishers inspected within last 12 months',
      'Fire alarm system operational',
      'Emergency exit signs illuminated',
      'Emergency lighting functional',
      'Fire exits clear and unobstructed',
      'Fire evacuation plan posted'
    ]
  },
  {
    category: 'Personal Protective Equipment',
    items: [
      'Hard hats available and worn in required areas',
      'Safety glasses / goggles available',
      'High-visibility vests worn',
      'Safety boots / footwear worn',
      'Gloves available for hazardous tasks',
      'Hearing protection available in noisy areas',
      'Respiratory protection available when needed'
    ]
  },
  {
    category: 'Fall Protection',
    items: [
      'Guardrails installed at elevated areas (≥4 ft)',
      'Safety harnesses used for work at height',
      'Ladders in good condition and properly secured',
      'Scaffolding erected by competent person',
      'Floor openings covered and guarded'
    ]
  },
  {
    category: 'Electrical Safety',
    items: [
      'Electrical panels properly labelled and accessible',
      'Extension cords used appropriately',
      'GFCI protection in wet / damp areas',
      'Exposed wiring properly protected',
      'Lockout / Tagout procedures followed'
    ]
  },
  {
    category: 'Chemical & Hazmat',
    items: [
      'Hazardous materials properly labelled (GHS)',
      'Safety Data Sheets (SDS) available and current',
      'Chemical storage area organised and ventilated',
      'Spill kits available and accessible',
      'Hazardous waste disposal procedures followed'
    ]
  },
  {
    category: 'First Aid & Emergency',
    items: [
      'First aid kits stocked and accessible',
      'First aid trained personnel on site',
      'Emergency contact numbers posted',
      'Eyewash stations available where needed',
      'Incident reporting procedures in place'
    ]
  },
  {
    category: 'Equipment & Machinery',
    items: [
      'Equipment maintenance records up to date',
      'Machine guards in place and functional',
      'Operators trained and certified',
      'Pre-operation safety checks performed',
      'Damaged equipment tagged out of service'
    ]
  },
  {
    category: 'Housekeeping & General',
    items: [
      'Walkways clear, marked, and adequate width',
      'Waste properly segregated and disposed',
      'Materials properly stored and stacked',
      'Adequate lighting throughout facility',
      'Sanitation facilities adequate and clean'
    ]
  }
];

// ---------- Seed demo data ----------
function seedDemoData() {
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get('inspector@demo.com');
  if (existing) return;

  const hash = bcrypt.hashSync('password123', 10);

  const insp1 = db.prepare(
    'INSERT INTO users (email, password, name, role, company) VALUES (?, ?, ?, ?, ?)'
  ).run('inspector@demo.com', hash, 'James Carter', 'inspector', 'SafeInspect Ltd').lastInsertRowid;

  const insp2 = db.prepare(
    'INSERT INTO users (email, password, name, role, company) VALUES (?, ?, ?, ?, ?)'
  ).run('inspector2@demo.com', hash, 'Maria Torres', 'inspector', 'ProCheck Services').lastInsertRowid;

  db.prepare(
    'INSERT INTO users (email, password, name, role, company) VALUES (?, ?, ?, ?, ?)'
  ).run('insurance@demo.com', hash, 'Sarah Johnson', 'insurance', 'SafeGuard Insurance Co.');

  // deterministic status helper
  const assignStatus = (idx, seed, rate) => {
    const v = ((idx * 1234 + seed * 57) % 100 + 100) % 100;
    if (v < 8) return 'na';
    return v < 8 + rate * 92 ? 'compliant' : 'non_compliant';
  };

  const createInspection = (inspId, meta, rate, seed, reviewedBy) => {
    const r = db.prepare(`
      INSERT INTO inspections (inspector_id, site_name, site_address, site_type,
        inspection_date, status, notes, insurance_notes, submitted_at, reviewed_at, reviewed_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      inspId, meta.site_name, meta.site_address, meta.site_type,
      meta.inspection_date, meta.status, meta.notes, meta.insurance_notes || null,
      meta.submitted_at || null, meta.reviewed_at || null, reviewedBy || null
    );
    const iid = r.lastInsertRowid;
    const stmt = db.prepare(
      'INSERT INTO inspection_items (inspection_id, category, item_name, status) VALUES (?, ?, ?, ?)'
    );
    let globalIdx = 0;
    CHECKLIST.forEach(section => {
      section.items.forEach(item => {
        stmt.run(iid, section.category, item, assignStatus(globalIdx++, seed, rate));
      });
    });
    updateScore(iid);
    return iid;
  };

  const insuranceUserId = db.prepare("SELECT id FROM users WHERE role='insurance'").get().id;

  createInspection(insp1, {
    site_name: 'Metro Steel Manufacturing',
    site_address: '45 Industrial Parkway, Detroit, MI 48201',
    site_type: 'Manufacturing',
    inspection_date: '2026-05-12',
    status: 'approved',
    notes: 'Overall site is well-maintained. Minor issues noted in electrical panels. Recommend follow-up on fire extinguisher inspection records.',
    insurance_notes: 'All critical safety requirements met. Approved with standard premium. Re-inspection scheduled in 12 months.',
    submitted_at: '2026-05-13 09:15:00',
    reviewed_at: '2026-05-14 14:30:00'
  }, 0.90, 1, insuranceUserId);

  createInspection(insp1, {
    site_name: 'Riverside Construction Site',
    site_address: '800 River Road, Cincinnati, OH 45202',
    site_type: 'Construction',
    inspection_date: '2026-05-08',
    status: 'rejected',
    notes: 'Significant deficiencies found. Multiple fall protection gaps, missing SDS sheets, and several fire exits blocked.',
    insurance_notes: 'Critical violations present. Coverage cannot be extended until all non-compliant items are remediated. Re-inspection required.',
    submitted_at: '2026-05-09 11:00:00',
    reviewed_at: '2026-05-10 10:00:00'
  }, 0.45, 2, insuranceUserId);

  createInspection(insp2, {
    site_name: 'Central Warehouse District',
    site_address: '220 Logistics Blvd, Memphis, TN 38103',
    site_type: 'Warehouse',
    inspection_date: '2026-05-15',
    status: 'under_review',
    notes: 'Warehouse in generally good condition. Some housekeeping issues in Bay 3. Forklift operator certification records need updating.',
    insurance_notes: null,
    submitted_at: '2026-05-16 08:45:00',
    reviewed_at: null
  }, 0.80, 3, null);

  createInspection(insp2, {
    site_name: 'Downtown Office Complex',
    site_address: '1 Commerce Plaza, Atlanta, GA 30303',
    site_type: 'Office',
    inspection_date: '2026-05-17',
    status: 'submitted',
    notes: 'Standard office environment. Emergency lighting on floor 8 needs replacement. Otherwise well-managed.',
    insurance_notes: null,
    submitted_at: '2026-05-18 13:20:00',
    reviewed_at: null
  }, 0.85, 4, null);

  createInspection(insp1, {
    site_name: 'FreshPack Food Processing',
    site_address: '600 Industrial Ave, Chicago, IL 60612',
    site_type: 'Food Processing',
    inspection_date: '2026-05-20',
    status: 'draft',
    notes: '',
    insurance_notes: null,
    submitted_at: null,
    reviewed_at: null
  }, 0.70, 5, null);
}

seedDemoData();

// ---------- Middleware ----------
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'uploads/'),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${uuidv4()}${ext}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = /jpeg|jpg|png|gif|webp/;
    cb(null, allowed.test(path.extname(file.originalname).toLowerCase()) && allowed.test(file.mimetype));
  }
});

function auth(req, res, next) {
  const token = (req.headers.authorization || '').split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token provided' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function role(r) {
  return (req, res, next) => {
    if (req.user.role !== r) return res.status(403).json({ error: 'Forbidden' });
    next();
  };
}

// ---------- Auth routes ----------
app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase().trim());
  if (!user || !bcrypt.compareSync(password, user.password)) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  const token = jwt.sign(
    { id: user.id, email: user.email, name: user.name, role: user.role, company: user.company },
    JWT_SECRET,
    { expiresIn: '8h' }
  );
  res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role, company: user.company } });
});

app.get('/api/auth/me', auth, (req, res) => res.json({ user: req.user }));

// ---------- Checklist ----------
app.get('/api/checklist', auth, (req, res) => res.json(CHECKLIST));

// ---------- Inspector routes ----------
app.get('/api/reports', auth, role('inspector'), (req, res) => {
  const reports = db.prepare(`
    SELECT i.*, u.name AS inspector_name
    FROM inspections i JOIN users u ON i.inspector_id = u.id
    WHERE i.inspector_id = ?
    ORDER BY i.updated_at DESC
  `).all(req.user.id);

  const result = reports.map(r => {
    const counts = db.prepare(`
      SELECT COUNT(*) AS total,
             SUM(CASE WHEN status='compliant' THEN 1 ELSE 0 END) AS compliant,
             SUM(CASE WHEN status='non_compliant' THEN 1 ELSE 0 END) AS non_compliant
      FROM inspection_items WHERE inspection_id = ?
    `).get(r.id);
    return { ...r, ...counts };
  });
  res.json(result);
});

app.post('/api/reports', auth, role('inspector'), (req, res) => {
  const { site_name, site_address, site_type, inspection_date, notes, items } = req.body;
  if (!site_name || !site_address || !inspection_date) {
    return res.status(400).json({ error: 'Site name, address, and inspection date are required' });
  }

  const r = db.prepare(`
    INSERT INTO inspections (inspector_id, site_name, site_address, site_type, inspection_date, notes, status)
    VALUES (?, ?, ?, ?, ?, ?, 'draft')
  `).run(req.user.id, site_name, site_address, site_type || '', inspection_date, notes || '');

  const iid = r.lastInsertRowid;
  if (Array.isArray(items)) {
    const stmt = db.prepare(
      'INSERT INTO inspection_items (inspection_id, category, item_name, status, notes) VALUES (?, ?, ?, ?, ?)'
    );
    items.forEach(it => stmt.run(iid, it.category, it.item_name, it.status || 'na', it.notes || ''));
    updateScore(iid);
  }
  res.status(201).json({ id: iid });
});

app.get('/api/reports/:id', auth, (req, res) => {
  const insp = db.prepare(`
    SELECT i.*, u.name AS inspector_name, u.company AS inspector_company, u.email AS inspector_email,
           u2.name AS reviewer_name
    FROM inspections i JOIN users u ON i.inspector_id = u.id
    LEFT JOIN users u2 ON i.reviewed_by = u2.id
    WHERE i.id = ?
  `).get(req.params.id);

  if (!insp) return res.status(404).json({ error: 'Report not found' });
  if (req.user.role === 'inspector' && insp.inspector_id !== req.user.id) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const items = db.prepare(
    'SELECT * FROM inspection_items WHERE inspection_id = ? ORDER BY category, item_name'
  ).all(req.params.id);
  const photos = db.prepare(
    'SELECT * FROM inspection_photos WHERE inspection_id = ? ORDER BY uploaded_at'
  ).all(req.params.id);

  res.json({ ...insp, items, photos });
});

app.put('/api/reports/:id', auth, role('inspector'), (req, res) => {
  const insp = db.prepare('SELECT * FROM inspections WHERE id = ?').get(req.params.id);
  if (!insp) return res.status(404).json({ error: 'Report not found' });
  if (insp.inspector_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });
  if (insp.status !== 'draft') return res.status(400).json({ error: 'Only draft reports can be edited' });

  const { site_name, site_address, site_type, inspection_date, notes, items } = req.body;
  db.prepare(`
    UPDATE inspections SET site_name=COALESCE(?,site_name), site_address=COALESCE(?,site_address),
      site_type=COALESCE(?,site_type), inspection_date=COALESCE(?,inspection_date),
      notes=COALESCE(?,notes), updated_at=CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(site_name, site_address, site_type, inspection_date, notes, req.params.id);

  if (Array.isArray(items)) {
    db.prepare('DELETE FROM inspection_items WHERE inspection_id = ?').run(req.params.id);
    const stmt = db.prepare(
      'INSERT INTO inspection_items (inspection_id, category, item_name, status, notes) VALUES (?, ?, ?, ?, ?)'
    );
    items.forEach(it => stmt.run(req.params.id, it.category, it.item_name, it.status || 'na', it.notes || ''));
    updateScore(req.params.id);
  }
  res.json({ message: 'Report updated' });
});

app.post('/api/reports/:id/submit', auth, role('inspector'), (req, res) => {
  const insp = db.prepare('SELECT * FROM inspections WHERE id = ?').get(req.params.id);
  if (!insp) return res.status(404).json({ error: 'Report not found' });
  if (insp.inspector_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });
  if (insp.status !== 'draft') return res.status(400).json({ error: 'Report already submitted' });

  db.prepare(`UPDATE inspections SET status='submitted', submitted_at=CURRENT_TIMESTAMP,
    updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(req.params.id);
  res.json({ message: 'Report submitted successfully' });
});

app.post('/api/reports/:id/photos', auth, role('inspector'), upload.array('photos', 10), (req, res) => {
  const insp = db.prepare('SELECT * FROM inspections WHERE id = ?').get(req.params.id);
  if (!insp) return res.status(404).json({ error: 'Report not found' });
  if (insp.inspector_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });

  const captions = [].concat(req.body.captions || []);
  const stmt = db.prepare(
    'INSERT INTO inspection_photos (inspection_id, filename, original_name, caption) VALUES (?, ?, ?, ?)'
  );
  const uploaded = (req.files || []).map((f, i) => {
    const r = stmt.run(req.params.id, f.filename, f.originalname, captions[i] || '');
    return { id: r.lastInsertRowid, filename: f.filename, original_name: f.originalname, caption: captions[i] || '' };
  });
  res.json({ uploaded });
});

app.delete('/api/reports/:id/photos/:photoId', auth, role('inspector'), (req, res) => {
  const photo = db.prepare('SELECT * FROM inspection_photos WHERE id=? AND inspection_id=?')
    .get(req.params.photoId, req.params.id);
  if (!photo) return res.status(404).json({ error: 'Photo not found' });

  try { fs.unlinkSync(path.join('uploads', photo.filename)); } catch {}
  db.prepare('DELETE FROM inspection_photos WHERE id=?').run(req.params.photoId);
  res.json({ message: 'Photo deleted' });
});

app.get('/api/reports/:id/pdf', auth, (req, res) => {
  const insp = db.prepare(`
    SELECT i.*, u.name AS inspector_name, u.company AS inspector_company, u.email AS inspector_email,
           u2.name AS reviewer_name
    FROM inspections i JOIN users u ON i.inspector_id = u.id
    LEFT JOIN users u2 ON i.reviewed_by = u2.id
    WHERE i.id = ?
  `).get(req.params.id);

  if (!insp) return res.status(404).json({ error: 'Report not found' });
  if (req.user.role === 'inspector' && insp.inspector_id !== req.user.id) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const items = db.prepare('SELECT * FROM inspection_items WHERE inspection_id=? ORDER BY category, item_name').all(req.params.id);
  const photos = db.prepare('SELECT * FROM inspection_photos WHERE inspection_id=? ORDER BY uploaded_at').all(req.params.id);

  const doc = new PDFDocument({ margin: 50, size: 'A4' });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="inspection-report-${insp.id}.pdf"`);
  doc.pipe(res);
  generatePDF(doc, insp, items, photos);
  doc.end();
});

// ---------- Insurance routes ----------
app.get('/api/insurance/dashboard', auth, role('insurance'), (req, res) => {
  const stats = {
    total: db.prepare("SELECT COUNT(*) AS c FROM inspections WHERE status!='draft'").get().c,
    submitted: db.prepare("SELECT COUNT(*) AS c FROM inspections WHERE status='submitted'").get().c,
    under_review: db.prepare("SELECT COUNT(*) AS c FROM inspections WHERE status='under_review'").get().c,
    approved: db.prepare("SELECT COUNT(*) AS c FROM inspections WHERE status='approved'").get().c,
    rejected: db.prepare("SELECT COUNT(*) AS c FROM inspections WHERE status='rejected'").get().c
  };

  const avgScore = db.prepare(`
    SELECT AVG(CASE WHEN max_score>0 THEN CAST(score AS REAL)/max_score*100 ELSE 0 END) AS avg
    FROM inspections WHERE status IN ('submitted','under_review','approved','rejected')
  `).get().avg || 0;

  const recentReports = db.prepare(`
    SELECT i.id, i.site_name, i.status, i.inspection_date, i.score, i.max_score,
           i.site_type, u.name AS inspector_name, u.company AS inspector_company
    FROM inspections i JOIN users u ON i.inspector_id = u.id
    WHERE i.status != 'draft'
    ORDER BY i.updated_at DESC LIMIT 5
  `).all();

  const scoresByCategory = db.prepare(`
    SELECT ii.category,
           SUM(CASE WHEN ii.status!='na' THEN 1 ELSE 0 END) AS applicable,
           SUM(CASE WHEN ii.status='compliant' THEN 1 ELSE 0 END) AS compliant
    FROM inspection_items ii JOIN inspections i ON ii.inspection_id=i.id
    WHERE i.status IN ('approved','rejected','submitted','under_review')
    GROUP BY ii.category ORDER BY ii.category
  `).all();

  const submissionsOverTime = db.prepare(`
    SELECT strftime('%Y-%m', submitted_at) AS month, COUNT(*) AS count
    FROM inspections WHERE submitted_at IS NOT NULL
    GROUP BY month ORDER BY month DESC LIMIT 6
  `).all().reverse();

  res.json({ stats, avgScore: Math.round(avgScore), recentReports, scoresByCategory, submissionsOverTime });
});

app.get('/api/insurance/reports', auth, role('insurance'), (req, res) => {
  const { status, search } = req.query;
  let q = `SELECT i.*, u.name AS inspector_name, u.company AS inspector_company
           FROM inspections i JOIN users u ON i.inspector_id = u.id
           WHERE i.status != 'draft'`;
  const params = [];
  if (status) { q += ' AND i.status=?'; params.push(status); }
  if (search) {
    q += ' AND (i.site_name LIKE ? OR i.site_address LIKE ? OR u.name LIKE ?)';
    params.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }
  q += ' ORDER BY i.updated_at DESC';
  res.json(db.prepare(q).all(...params));
});

app.get('/api/insurance/reports/:id', auth, role('insurance'), (req, res) => {
  const insp = db.prepare(`
    SELECT i.*, u.name AS inspector_name, u.company AS inspector_company, u.email AS inspector_email,
           u2.name AS reviewer_name
    FROM inspections i JOIN users u ON i.inspector_id=u.id
    LEFT JOIN users u2 ON i.reviewed_by=u2.id
    WHERE i.id=? AND i.status!='draft'
  `).get(req.params.id);
  if (!insp) return res.status(404).json({ error: 'Report not found' });

  const items = db.prepare('SELECT * FROM inspection_items WHERE inspection_id=? ORDER BY category, item_name').all(req.params.id);
  const photos = db.prepare('SELECT * FROM inspection_photos WHERE inspection_id=? ORDER BY uploaded_at').all(req.params.id);
  res.json({ ...insp, items, photos });
});

app.put('/api/insurance/reports/:id/review', auth, role('insurance'), (req, res) => {
  const { status, insurance_notes } = req.body;
  if (!['approved', 'rejected', 'under_review'].includes(status)) {
    return res.status(400).json({ error: 'Status must be approved, rejected, or under_review' });
  }
  const insp = db.prepare("SELECT * FROM inspections WHERE id=? AND status!='draft'").get(req.params.id);
  if (!insp) return res.status(404).json({ error: 'Report not found' });

  db.prepare(`UPDATE inspections SET status=?, insurance_notes=?, reviewed_by=?,
    reviewed_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(status, insurance_notes || '', req.user.id, req.params.id);
  res.json({ message: `Report ${status}` });
});

app.get('/api/insurance/reports/:id/pdf', auth, role('insurance'), (req, res) => {
  const insp = db.prepare(`
    SELECT i.*, u.name AS inspector_name, u.company AS inspector_company, u.email AS inspector_email,
           u2.name AS reviewer_name
    FROM inspections i JOIN users u ON i.inspector_id=u.id
    LEFT JOIN users u2 ON i.reviewed_by=u2.id
    WHERE i.id=? AND i.status!='draft'
  `).get(req.params.id);
  if (!insp) return res.status(404).json({ error: 'Report not found' });

  const items = db.prepare('SELECT * FROM inspection_items WHERE inspection_id=? ORDER BY category, item_name').all(req.params.id);
  const photos = db.prepare('SELECT * FROM inspection_photos WHERE inspection_id=? ORDER BY uploaded_at').all(req.params.id);

  const doc = new PDFDocument({ margin: 50, size: 'A4' });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="inspection-report-${insp.id}.pdf"`);
  doc.pipe(res);
  generatePDF(doc, insp, items, photos);
  doc.end();
});

// ---------- Helpers ----------
function updateScore(iid) {
  const c = db.prepare(`
    SELECT SUM(CASE WHEN status!='na' THEN 1 ELSE 0 END) AS applicable,
           SUM(CASE WHEN status='compliant' THEN 1 ELSE 0 END) AS compliant
    FROM inspection_items WHERE inspection_id=?
  `).get(iid);
  db.prepare('UPDATE inspections SET score=?, max_score=? WHERE id=?')
    .run(c.compliant || 0, c.applicable || 0, iid);
}

function generatePDF(doc, insp, items, photos) {
  const scorePercent = insp.max_score > 0 ? Math.round((insp.score / insp.max_score) * 100) : 0;
  const statusColors = { submitted: '#2563eb', under_review: '#d97706', approved: '#16a34a', rejected: '#dc2626', draft: '#64748b' };
  const scoreColor = scorePercent >= 80 ? '#16a34a' : scorePercent >= 60 ? '#d97706' : '#dc2626';

  // Header banner
  doc.rect(0, 0, doc.page.width, 90).fill('#1e3a5f');
  doc.fillColor('white').fontSize(20).font('Helvetica-Bold')
    .text('WORKPLACE SAFETY INSPECTION REPORT', 50, 28, { align: 'center' });
  doc.fontSize(11).font('Helvetica')
    .text('Safety Inspection Management System', 50, 55, { align: 'center' });

  doc.fillColor('#1e293b');
  let y = 110;

  // Summary box
  doc.rect(50, y, 495, 110).fillAndStroke('#f8fafc', '#e2e8f0');
  const c1 = 65, c2 = 320;
  y += 14;
  doc.fontSize(9).font('Helvetica-Bold').fillColor('#64748b').text('REPORT ID', c1, y).text('STATUS', c2, y);
  y += 13;
  doc.fontSize(14).font('Helvetica-Bold').fillColor('#1e293b').text(`#${insp.id}`, c1, y);
  const statusLabel = insp.status.replace('_', ' ').toUpperCase();
  doc.fontSize(13).font('Helvetica-Bold').fillColor(statusColors[insp.status] || '#64748b').text(statusLabel, c2, y);
  y += 24;
  doc.fontSize(9).font('Helvetica-Bold').fillColor('#64748b').text('SITE NAME', c1, y).text('COMPLIANCE SCORE', c2, y);
  y += 13;
  doc.fontSize(12).font('Helvetica').fillColor('#1e293b').text(insp.site_name, c1, y, { width: 230 });
  doc.fontSize(22).font('Helvetica-Bold').fillColor(scoreColor).text(`${scorePercent}%`, c2, y - 4);
  doc.fontSize(9).font('Helvetica').fillColor('#64748b').text(`(${insp.score} / ${insp.max_score} items)`, c2 + 58, y + 3);
  y += 50;

  const rows = [
    ['Site Address', insp.site_address, 'Inspector', insp.inspector_name],
    ['Site Type', insp.site_type || 'N/A', 'Company', insp.inspector_company || 'N/A'],
    ['Inspection Date', insp.inspection_date, 'Email', insp.inspector_email],
    ['Submitted', insp.submitted_at ? new Date(insp.submitted_at).toLocaleDateString() : 'N/A',
     'Reviewed By', insp.reviewer_name || 'Pending']
  ];
  rows.forEach(([l1, v1, l2, v2]) => {
    doc.fontSize(9).font('Helvetica-Bold').fillColor('#64748b').text(l1, c1, y).text(l2, c2, y);
    y += 13;
    doc.fontSize(10).font('Helvetica').fillColor('#1e293b').text(v1, c1, y, { width: 230 }).text(v2, c2, y, { width: 200 });
    y += 18;
  });

  y += 15;
  doc.fontSize(13).font('Helvetica-Bold').fillColor('#1e3a5f').text('SAFETY CHECKLIST RESULTS', 50, y);
  y += 18;

  const byCategory = {};
  items.forEach(it => { (byCategory[it.category] = byCategory[it.category] || []).push(it); });

  Object.entries(byCategory).forEach(([cat, catItems]) => {
    const applicable = catItems.filter(i => i.status !== 'na').length;
    const compliant = catItems.filter(i => i.status === 'compliant').length;
    const pct = applicable > 0 ? Math.round((compliant / applicable) * 100) : 0;
    const cc = pct >= 80 ? '#16a34a' : pct >= 60 ? '#d97706' : '#dc2626';

    if (y > 700) { doc.addPage(); y = 50; }
    doc.rect(50, y, 495, 20).fill('#e8eef7');
    doc.fontSize(9).font('Helvetica-Bold').fillColor('#1e3a5f').text(cat.toUpperCase(), 60, y + 5);
    doc.fontSize(9).font('Helvetica-Bold').fillColor(cc)
      .text(`${pct}%  (${compliant}/${applicable})`, 400, y + 5, { width: 135, align: 'right' });
    y += 20;

    catItems.forEach(it => {
      if (y > 720) { doc.addPage(); y = 50; }
      const icon = it.status === 'compliant' ? '✓' : it.status === 'non_compliant' ? '✗' : '–';
      const ic = it.status === 'compliant' ? '#16a34a' : it.status === 'non_compliant' ? '#dc2626' : '#94a3b8';
      doc.fontSize(9).font('Helvetica-Bold').fillColor(ic).text(icon, 60, y + 2);
      doc.fontSize(9).font('Helvetica').fillColor('#1e293b').text(it.item_name, 80, y + 2, { width: 320 });
      y += it.notes ? 14 : 17;
      if (it.notes) {
        doc.fontSize(8).font('Helvetica-Oblique').fillColor('#64748b').text(`Note: ${it.notes}`, 80, y, { width: 320 });
        y += 14;
      }
    });
    y += 4;
  });

  if (insp.notes) {
    if (y > 660) { doc.addPage(); y = 50; }
    doc.fontSize(13).font('Helvetica-Bold').fillColor('#1e3a5f').text('INSPECTOR NOTES', 50, y);
    y += 14; doc.rect(50, y, 495, 1).fill('#e2e8f0'); y += 8;
    doc.fontSize(10).font('Helvetica').fillColor('#1e293b').text(insp.notes, 50, y, { width: 495 });
    y += doc.heightOfString(insp.notes, { width: 495 }) + 18;
  }

  if (insp.insurance_notes) {
    if (y > 660) { doc.addPage(); y = 50; }
    doc.fontSize(13).font('Helvetica-Bold').fillColor('#1e3a5f').text('INSURANCE PROVIDER REVIEW NOTES', 50, y);
    y += 14; doc.rect(50, y, 495, 1).fill('#e2e8f0'); y += 8;
    doc.fontSize(10).font('Helvetica').fillColor('#1e293b').text(insp.insurance_notes, 50, y, { width: 495 });
    y += doc.heightOfString(insp.insurance_notes, { width: 495 }) + 18;
  }

  if (photos.length > 0) {
    if (y > 660) { doc.addPage(); y = 50; }
    doc.fontSize(13).font('Helvetica-Bold').fillColor('#1e3a5f').text('PHOTOGRAPHIC EVIDENCE', 50, y);
    y += 18;
    let col = 0;
    photos.forEach(photo => {
      const pp = path.join('uploads', photo.filename);
      if (!fs.existsSync(pp)) return;
      if (y > 640) { doc.addPage(); y = 50; col = 0; }
      const x = 50 + col * 252;
      try {
        doc.image(pp, x, y, { width: 220, height: 155, fit: [220, 155] });
        doc.fontSize(8).font('Helvetica').fillColor('#64748b')
          .text(photo.caption || photo.original_name, x, y + 160, { width: 220, align: 'center' });
      } catch {}
      col++;
      if (col >= 2) { col = 0; y += 195; }
    });
    if (col > 0) y += 195;
  }

  doc.fontSize(8).font('Helvetica').fillColor('#94a3b8')
    .text(`Generated ${new Date().toLocaleString()} — Safety Inspection Management System`,
      50, doc.page.height - 35, { width: 495, align: 'center' });
}

app.listen(PORT, () => {
  console.log(`\n  Safety Inspection App → http://localhost:${PORT}`);
  console.log('\n  Demo credentials:');
  console.log('    Inspector : inspector@demo.com  / password123');
  console.log('    Inspector2: inspector2@demo.com / password123');
  console.log('    Insurance : insurance@demo.com  / password123\n');
});
