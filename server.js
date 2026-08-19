// Sunworld Command Center — Production-Ready Server
require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const db = require('./src/db');

const ROOT = __dirname;
const PUB = path.join(ROOT, 'public');
const UPLOADS = path.join(ROOT, 'uploads');
const LOGS = path.join(ROOT, 'logs');
const PORT = process.env.PORT || 4173;

// Create uploads & logs directories
fs.mkdirSync(UPLOADS, { recursive: true });
fs.mkdirSync(LOGS, { recursive: true });

const app = express();

// ---- Crash-proofing Logging ----
function logError(context, err) {
  try {
    const line = `[${new Date().toISOString()}] ${context}: ${err && err.stack || err}\n`;
    fs.appendFileSync(path.join(LOGS, 'error.log'), line);
  } catch (e) {
    // Logging must never crash the server
  }
  console.error(`[${context}]`, err);
}

process.on('uncaughtException', err => logError('uncaughtException', err));
process.on('unhandledRejection', err => logError('unhandledRejection', err));

// ---- Global Middleware ----
// Helmet security headers (configured loosely on CSP to allow loading external CDNs in HTML pages)
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false
}));

// CORS middleware
app.use(cors());

// Parse requests
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

// Custom Cookie parser & session middleware
app.use(async (req, res, next) => {
  const h = req.headers.cookie || '';
  req.cookies = Object.fromEntries(h.split(';').map(v => v.trim().split('=').map(decodeURIComponent)).filter(a => a[0]));
  
  const sid = req.cookies.sw_sid;
  req.session = sid ? await db.getSession(sid) : null;
  next();
});

// Rate limiting configurations
const authLimiter = rateLimit.rateLimit({
  windowMs: 15 * 60 * 1000, // 15 mins
  max: 20, // Limit each IP to 20 login requests per window
  message: { error: 'Too many login attempts. Please try again in 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false
});

const apiLimiter = rateLimit.rateLimit({
  windowMs: 1 * 60 * 1000, // 1 min
  max: 300, // Limit each IP to 300 API requests per minute
  message: { error: 'Too many requests. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false
});

// CSRF Protection middleware
const csrfCheck = (req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (['/api/login', '/api/logout', '/api/reset'].includes(req.path)) return next();
  
  if (!req.session) {
    return res.status(401).json({ error: 'Session expired. Please sign in again.' });
  }
  const token = req.headers['x-csrf-token'];
  if (!token || token !== req.session.csrf) {
    return res.status(403).json({ error: 'Security validation failed (Invalid or missing CSRF token).' });
  }
  next();
};

app.use(csrfCheck);

// Multer Storage for File Uploads
const ALLOWED_UPLOAD_EXT = ['.pdf', '.jpg', '.jpeg', '.png', '.doc', '.docx', '.xls', '.xlsx', '.txt', '.webp'];
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, UPLOADS);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const id = req.params.id || 'upload';
    const stageId = req.body.stageId || 'stage';
    const fieldId = req.body.fieldId || 'field';
    const safeName = `${id}-${stageId}-${fieldId}-${Date.now()}${ext}`;
    cb(null, safeName);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 15 * 1024 * 1024 }, // 15MB file size limit
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED_UPLOAD_EXT.includes(ext)) {
      return cb(new Error(`File type "${ext}" is not allowed. Use PDF, Word, Excel, or an image.`), false);
    }
    cb(null, true);
  }
});

// ---- Password hashing ----
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}
function verifyPassword(password, stored) {
  if (!stored || !password) return false;
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const check = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return check.length === expected.length && crypto.timingSafeEqual(check, expected);
}

// ---- Process config constants ----
const STAGE_NAME = ['Enquiry & Survey', 'Quotation', 'Work Order', 'Drawings', 'Procurement', 'Site Execution', 'Quality / QC', 'Client Update', 'Invoicing', 'Handover'];
const STAGE_DOC = [
  'Initial meeting to understand the client\'s concept for the work. Key information is captured — site survey, existing plans and requirements — and a Job ID is generated.',
  'From the client\'s brief and our ideas we prepare proposal and concept design options. Project scope, budget and individual requirements are established, and a cost estimate (BOQ) is prepared.',
  'The approved proposal is converted into a Work Order — scope, quantity, delivery date and site team assigned. Every department works from this single Work Order.',
  'Developing design: concept design is developed through floor plans, perspective sketches and renderings, then advanced to detailed design — construction details, materials, components, systems and finishes. Every revision (R0, R1, R2) is tracked and client-approved.',
  'Raw materials are sourced against the BOQ — steel, roof sheeting, cladding, MEP — with purchase orders raised and deliveries tracked to site.',
  'Construction runs on site through the build sequence: foundation → column & beam erection → roofing → cladding → MEP → flooring → finishing, updated by the site engineers.',
  'Quality inspections and checklists run at each stage; inspection reports are recorded and client sign-off is captured before the next stage begins.',
  'A structured progress summary is generated and shared with the client at each milestone.',
  'Stage-wise billing is raised as milestones complete — mobilization advance, foundation, structure and completion.',
  'As-built drawings, completion certificate, warranty and test certificates are bundled and handed over to the client.',
];
const STEEL_SUB = ['Foundation', 'Column & Beam Erection', 'Roof Purlin & Sheeting', 'Wall Cladding', 'MEP Rough-in', 'Flooring', 'Finishing & Handover'];
const EPOXY_SUB = ['Surface Preparation', 'Primer Coat', 'Base Coat', 'Top Coat', 'Cure & Inspection', 'Handover'];
const VALID_SERVICES = ['warehouse', 'steel', 'epoxy', 'interior', 'exterior'];

function subFor(service) { return service === 'epoxy' ? EPOXY_SUB : STEEL_SUB; }
function newStageId() { return 'st-' + crypto.randomBytes(4).toString('hex'); }
function newFieldId() { return 'fld-' + crypto.randomBytes(3).toString('hex'); }
function defaultStages() {
  return STAGE_NAME.map((name, i) => ({ id: `st-${i + 1}`, name, desc: STAGE_DOC[i], kind: i === 5 ? 'site-execution' : null, fields: [] }));
}
function emptyModules() { return { materials: [], payments: [], documents: [], po: [], moduleAssignees: { progress: '', materials: '', payments: '', documents: '' } }; }

function canEditProcess(s) { return s.role === 'md' || s.role === 'supervisor'; }
function canAdvanceStage(s, proj) {
  const cur = (proj.stages || [])[proj.stage - 1]; if (!cur) return false;
  if (s.role === 'md') return true;
  if (cur.kind === 'site-execution') return !!(s.canSiteExecution && proj.assignees && proj.assignees[cur.id] === s.person);
  return !!s.canGeneral;
}
function canTouchStage(s, proj, stageObj) {
  if (s.role === 'md') return true;
  if (stageObj.kind === 'site-execution') return !!(s.canSiteExecution && proj.assignees && proj.assignees[stageObj.id] === s.person);
  return !!s.canGeneral;
}

const MODULES = ['progress', 'materials', 'payments', 'documents'];
const MODULE_LABEL = { progress: 'Project Progress', materials: 'Materials & Procurement', payments: 'Payment Milestones', documents: 'Document Center' };
const ROLE_NAME = { coordinator: 'Project Coordinator', sitemanager: 'Site Manager', supervisor: 'Supervisor' };

function canEditModule(s, proj, module) {
  if (s.role === 'md') return true;
  return !!(proj.moduleAssignees && proj.moduleAssignees[module] === s.role);
}

const PO_STATUS = ['Draft', 'Sent', 'Acknowledged', 'Received'];
function canEditPO(s) { return s.role === 'md' || s.role === 'supervisor'; }

async function nextPoId() {
  let max = 0;
  (await db.getProjectsList()).forEach(pr => {
    (pr.po || []).forEach(po => {
      const m = (po.id || '').match(/-(\d+)$/);
      if (m) {
        const n = parseInt(m[1], 10);
        if (n > max) max = n;
      }
    });
  });
  return `PO-2026-${String(max + 1).padStart(3, '0')}`;
}

const COMPANY = { name: 'Sunworld Infra Pvt Ltd', address: 'Coimbatore, Tamil Nadu, India', phone: '+91 98765 43210', email: 'procurement@sunworldinfra.com', web: 'www.sunworldinfra.com' };

function poTotals(po) {
  const items = po.items || [];
  const sub = items.reduce((s, it) => s + (Number(it.qty) || 0) * (Number(it.unitPrice) || 0), 0);
  const tax = sub * ((Number(po.taxPercent) || 0) / 100);
  const ship = Number(po.shippingFee) || 0;
  return { sub, tax, ship, total: sub + tax + ship };
}

function pctOf(p) {
  const subs = subFor(p.service);
  const stages = p.stages || defaultStages();
  const cur = stages[p.stage - 1];
  const isSiteExec = cur && cur.kind === 'site-execution';
  const total = Math.max(1, stages.length - 1);
  const frac = ((p.stage - 1) + (isSiteExec ? p.sub / subs.length : 0)) / total;
  return Math.max(0, Math.min(100, Math.round(frac * 100)));
}

async function doAdvance(p, sess) {
  let text;
  const subs = subFor(p.service);
  const stages = p.stages;
  const cur = stages[p.stage - 1];
  if (cur.kind === 'site-execution') {
    if (p.sub < subs.length - 1) {
      p.sub++;
      text = `advanced ${p.name} to “${subs[p.sub]}”`;
    } else {
      p.sub = 0;
      if (p.stage < stages.length) {
        p.stage++;
        text = `completed ${cur.name} on ${p.name} → moved to ${stages[p.stage - 1].name}`;
      } else {
        text = `completed ${cur.name} on ${p.name}`;
      }
    }
  } else {
    const from = cur.name;
    if (p.stage < stages.length) {
      p.stage++;
      text = `completed ${from} on ${p.name} → moved to ${stages[p.stage - 1].name}`;
    } else {
      text = `completed ${from} on ${p.name}`;
    }
  }
  if (p.note) p.note = '';
  if (p.status !== 'ok') p.status = 'ok';
  p.pct = pctOf(p);
  
  await db.updateProjectProgress(p.id, p.stage, p.sub, p.status, p.note, p.pct);
  await db.addUpdate({
    at: Date.now(),
    role: sess.role,
    roleName: sess.name,
    projectId: p.id,
    projectName: p.name,
    stage: p.stage,
    text: `${sess.name} ${text}`
  });
  return text;
}

async function nextJobId() {
  let max = 0;
  (await db.getProjectsList()).forEach(pr => {
    const m = pr.id.match(/-(\d+)$/);
    if (m) {
      const n = parseInt(m[1], 10);
      if (n > max) max = n;
    }
  });
  return `SW-2026-${String(max + 1).padStart(3, '0')}`;
}

// ---- Outbound email (Resend) ----
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const RESEND_FROM = process.env.RESEND_FROM || 'onboarding@resend.dev';
async function sendPoEmail(proj, po) {
  if (!RESEND_API_KEY) return { sent: false, reason: 'RESEND_API_KEY not configured' };
  if (!po.vendor.email) return { sent: false, reason: 'Vendor has no email address' };
  try {
    const pdf = poPdfBuffer(proj, po);
    const html = `<p>Dear ${esc(po.vendor.name)},</p>
      <p>Please find attached Purchase Order <b>${esc(po.id)}</b> from ${esc(COMPANY.name)} for project <b>${esc(proj.name)}</b>.</p>
      <p>Ship Via: ${esc(po.shipVia || '-')}<br>FOB: ${esc(po.fob || '-')}<br>Shipping Terms: ${esc(po.shippingTerms || '-')}</p>
      <p>Regards,<br>${esc(COMPANY.name)}</p>`;
      
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: RESEND_FROM,
        to: po.vendor.email,
        subject: `Purchase Order ${po.id} — ${COMPANY.name}`,
        html,
        attachments: [{ filename: `${po.id}.pdf`, content: pdf.toString('base64') }]
      })
    });
    if (!r.ok) {
      const t = await r.text();
      return { sent: false, reason: `Resend error: ${t.slice(0, 200)}` };
    }
    return { sent: true };
  } catch (e) {
    return { sent: false, reason: e.message };
  }
}
function esc(v) { return String(v == null ? '' : v).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

// ---- Hand-rolled PDF writer ----
const NAVY = '0.109 0.227 0.419';
function pdfEsc(s) { return String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)'); }
function pdfMoney(n) { return 'Rs. ' + Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function poPdfBuffer(proj, po) {
  const t = poTotals(po);
  const v = po.vendor || {}, sh = po.shipTo || {};
  const ops = [];
  const text = (x, y, size, s, opts = {}) => {
    const font = opts.bold ? '/F2' : '/F1';
    const color = opts.color || '0 0 0';
    ops.push(`q ${color} rg BT ${font} ${size} Tf 1 0 0 1 ${x} ${y} Tm (${pdfEsc(s)}) Tj ET Q`);
  };
  const rule = (x1, y, x2, w, color) => ops.push(`q ${color || NAVY} RG ${w} w ${x1} ${y} m ${x2} ${y} l S Q`);
  const rectFill = (x, y, w, h, color) => ops.push(`q ${color} rg ${x} ${y} ${w} ${h} re f Q`);

  const L = 40, R = 555;
  rectFill(0, 822, 595, 10, NAVY);
  text(L, 775, 24, 'PURCHASE ORDER', { bold: true, color: NAVY });

  let y = 748;
  text(L, y, 11, COMPANY.name, { bold: true }); y -= 14;
  [COMPANY.address, COMPANY.phone, COMPANY.email, COMPANY.web].forEach(l => { text(L, y, 10, l); y -= 13; });
  const metaX = 380, metaValX = 460;
  let my = 748;
  [['PO Number', po.id], ['Date', po.date || ''], ['Ship Via', po.shipVia || '-'], ['FOB', po.fob || '-'], ['Shipping Terms', po.shippingTerms || '-'], ['Status', po.status]].forEach(([k, val]) => {
    text(metaX, my, 9.5, k, { color: '0.35 0.35 0.35' }); text(metaValX, my, 9.5, String(val), { bold: true }); my -= 15;
  });

  y = Math.min(y, my) - 12;
  rule(L, y, R, 1.4); y -= 20;
  const vY0 = y;
  text(L, y, 10, 'VENDOR', { bold: true, color: NAVY }); y -= 15;
  text(L, y, 10.5, v.name || '', { bold: true }); y -= 13;
  [v.address, v.phone, v.email].filter(Boolean).forEach(l => { text(L, y, 9.5, l); y -= 13; });
  let sy = vY0;
  text(metaX, sy, 10, 'SHIP TO', { bold: true, color: NAVY }); sy -= 15;
  text(metaX, sy, 10.5, sh.name || proj.name, { bold: true }); sy -= 13;
  (sh.address ? [sh.address] : [proj.site]).concat([sh.phone, sh.email].filter(Boolean)).forEach(l => { text(metaX, sy, 9.5, l); sy -= 13; });

  y = Math.min(y, sy) - 8;
  rule(L, y, R, 1.4); y -= 24;

  const colItem = L, colQty = 310, colPrice = 380, colTotal = 475;
  text(colItem, y, 9.5, 'ITEM DETAILS', { bold: true, color: NAVY });
  text(colQty, y, 9.5, 'QTY', { bold: true, color: NAVY });
  text(colPrice, y, 9.5, 'UNIT PRICE', { bold: true, color: NAVY });
  text(colTotal, y, 9.5, 'TOTAL', { bold: true, color: NAVY });
  y -= 8; rule(L, y, R, 1.4); y -= 18;

  (po.items || []).forEach(it => {
    const lineTotal = (Number(it.qty) || 0) * (Number(it.unitPrice) || 0);
    text(colItem, y, 10, it.name || '', { bold: true });
    text(colQty, y, 10, String(it.qty || 0));
    text(colPrice, y, 10, pdfMoney(it.unitPrice));
    text(colTotal, y, 10, pdfMoney(lineTotal));
    y -= 13;
    if (it.desc) { text(colItem, y, 8.5, it.desc, { color: '0.45 0.45 0.45' }); y -= 13; }
    y -= 3; rule(L, y + 9, R, 0.6, '0.85 0.85 0.85'); y -= 8;
    if (y < 110) return;
  });

  y -= 12;
  const sumLabelX = 400, sumValX = 555, sumX0 = 380;
  const sumLine = (label, val, opts = {}) => {
    text(sumLabelX, y, opts.size || 10, label, { color: opts.color });
    text(sumValX - 70, y, opts.size || 10, val, { bold: opts.bold, color: opts.color });
    y -= (opts.gap || 16);
  };
  sumLine('Sub Total', pdfMoney(t.sub));
  sumLine(`Tax${po.taxPercent ? ` (${po.taxPercent}%)` : ''}`, pdfMoney(t.tax));
  sumLine('Shipping Fee', pdfMoney(t.ship));
  rule(sumX0, y + 10, R, 1.4);
  sumLine('Total', pdfMoney(t.total), { bold: true, color: NAVY, size: 13, gap: 0 });

  const content = ops.join('\n');
  const objs = [];
  objs.push('1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n');
  objs.push('2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n');
  objs.push('3 0 obj << /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /MediaBox [0 0 595 842] /Contents 6 0 R >> endobj\n');
  objs.push('4 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj\n');
  objs.push('5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >> endobj\n');
  objs.push(`6 0 obj << /Length ${Buffer.byteLength(content, 'latin1')} >> stream\n${content}\nendstream endobj\n`);

  let out = '%PDF-1.4\n';
  const offsets = [0];
  objs.forEach(o => { offsets.push(Buffer.byteLength(out, 'latin1')); out += o; });
  const xrefStart = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objs.length; i++) out += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
  out += `trailer << /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  return Buffer.from(out, 'latin1');
}

// ---- Database Migration and User Seeding ----
async function migrateAndSeed() {
  await db.initDb();

  // Create default system users if they don't exist
  const USERS_SEED = [
    { user: 'admin', passHash: hashPassword(process.env.ADMIN_PASSWORD || 'admin123'), role: 'md', name: 'Managing Director', canGeneral: 1, canSiteExecution: 1, person: null },
    { user: 'sitemanager', passHash: hashPassword(process.env.SITEMANAGER_PASSWORD || 'sitemanager123'), role: 'sitemanager', name: 'Site Manager', canGeneral: 0, canSiteExecution: 1, person: 'Site Manager' },
    { user: 'supervisor', passHash: hashPassword(process.env.SUPERVISOR_PASSWORD || 'supervisor123'), role: 'supervisor', name: 'Supervisor', canGeneral: 1, canSiteExecution: 1, person: 'Supervisor' },
    { user: 'coordinator', passHash: hashPassword(process.env.COORDINATOR_PASSWORD || 'coordinator123'), role: 'coordinator', name: 'Project Coordinator', canGeneral: 1, canSiteExecution: 0, person: null }
  ];

  for (const u of USERS_SEED) {
    await db.insertUser(u.user, u.passHash, u.role, u.name, u.canGeneral, u.canSiteExecution, u.person);
  }

  // Check if a legacy db.json file needs to be migrated to SQLite
  const DB_JSON_PATH = path.join(ROOT, 'db.json');
  if (fs.existsSync(DB_JSON_PATH)) {
    try {
      console.log('[migration] Found db.json, checking if migration is needed...');
      const data = JSON.parse(fs.readFileSync(DB_JSON_PATH, 'utf8'));
      
      const count = (await db.getProjectsList()).length;
      if (count === 0 && data.projects) {
        console.log('[migration] Importing projects into SQLite db...');
        for (const p of Object.values(data.projects)) {
          await db.createProject(p);
        }
        console.log(`[migration] Successfully migrated ${Object.keys(data.projects).length} projects.`);
      }

      // Migrate log updates
      const updateCount = (await db.getUpdatesList(100)).length;
      if (updateCount === 0 && Array.isArray(data.updates)) {
        console.log('[migration] Importing update logs into SQLite db...');
        const reversedUpdates = [...data.updates].reverse(); // reverse to preserve order
        for (const u of reversedUpdates) {
          await db.addUpdate(u);
        }
      }

      // Migrate session storage
      const sessionsCount = Object.keys(await db.getAllSessions()).length;
      if (sessionsCount === 0 && data.sessions) {
        console.log('[migration] Importing legacy active sessions...');
        for (const [sid, s] of Object.entries(data.sessions)) {
          await db.saveSession(sid, s);
        }
      }

      // Rename db.json to make migration non-recurring
      fs.renameSync(DB_JSON_PATH, DB_JSON_PATH + '.migrated');
      console.log('[migration] Migration complete. Renamed db.json to db.json.migrated.');
    } catch (e) {
      console.error('[migration] Migration process failed:', e);
    }
  }
}

// Initialize database
migrateAndSeed().catch(err => console.error('[migration] Startup failed:', err));

// Session cleaner (runs every hour)
const SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000;
setInterval(async () => {
  try {
    await db.cleanExpiredSessions(SESSION_MAX_AGE_MS);
  } catch (e) {
    logError('session-cleanup', e);
  }
}, 60 * 60 * 1000);

// ---- STATIC ASSETS ---- (logo, background photos, etc. — this was missing entirely, so every
// <img> on the login/app/team pages was 404ing)
app.use(express.static(PUB));

// ---- PAGE ROUTES ----
app.get('/login', (req, res) => {
  res.sendFile(path.join(PUB, 'login.html'));
});

app.get(['/', '/app', '/team'], (req, res) => {
  if (!req.session) {
    return res.redirect('/login');
  }
  const file = req.session.role === 'md' ? 'app.html' : 'team.html';
  res.sendFile(path.join(PUB, file));
});

// ---- API ENDPOINTS ----

// Login Endpoint
app.post('/api/login', authLimiter, async (req, res) => {
  const usernameInput = (req.body.user || '').toLowerCase().trim();
  const passwordInput = req.body.pass || '';
  
  if (!usernameInput || !passwordInput) {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  const userRecord = await db.getUser(usernameInput);
  if (userRecord && verifyPassword(passwordInput, userRecord.passHash)) {
    const sid = crypto.randomBytes(16).toString('hex');
    const csrf = crypto.randomBytes(24).toString('hex');
    
    const sess = {
      user: usernameInput,
      role: userRecord.role,
      name: userRecord.name,
      canGeneral: userRecord.canGeneral,
      canSiteExecution: userRecord.canSiteExecution,
      person: userRecord.person,
      csrf,
      createdAt: Date.now()
    };
    
    await db.saveSession(sid, sess);
    
    res.cookie('sw_sid', sid, {
      path: '/',
      httpOnly: true,
      maxAge: 24 * 60 * 60 * 1000,
      sameSite: 'Lax',
      secure: process.env.NODE_ENV === 'production'
    });
    
    return res.json({ ok: true, role: sess.role, name: sess.name, csrf });
  }

  return res.status(401).json({ error: 'Invalid username or password' });
});

// Logout Endpoint
app.post('/api/logout', async (req, res) => {
  const sid = req.cookies.sw_sid;
  if (sid) {
    await db.deleteSession(sid);
  }
  res.clearCookie('sw_sid');
  res.json({ ok: true });
});

app.use('/api', apiLimiter);

// Get User session
app.get('/api/me', (req, res) => {
  if (!req.session) return res.status(401).json({ error: 'auth' });
  res.json({
    user: req.session.user,
    role: req.session.role,
    name: req.session.name,
    canGeneral: req.session.canGeneral,
    canSiteExecution: req.session.canSiteExecution,
    person: req.session.person,
    csrf: req.session.csrf
  });
});

// Get Projects list
app.get('/api/projects', async (req, res) => {
  if (!req.session) return res.status(401).json({ error: 'auth' });
  res.json({
    projects: await db.getProjectsList(),
    updates: await db.getUpdatesList(15)
  });
});

// Create Project
app.post('/api/projects/create', async (req, res) => {
  if (!req.session) return res.status(401).json({ error: 'auth' });
  if (req.session.role !== 'md') return res.status(403).json({ error: 'Only the Managing Director can start a new project' });

  const name = (req.body.name || '').trim();
  const site = (req.body.site || '').trim();
  const service = (req.body.service || '').trim();

  if (!name || !site) return res.status(400).json({ error: 'Client name and site are required' });
  if (!VALID_SERVICES.includes(service)) return res.status(400).json({ error: 'Invalid service' });

  const id = await nextJobId();
  const start = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  
  const proj = Object.assign({
    id, service, name, site,
    tag: (req.body.tag || '').trim() || 'New project',
    val: (req.body.val || '').trim() || '₹0.0 L',
    team: 'Unassigned', start, delivery: (req.body.delivery || '').trim() || '—',
    stage: 1, sub: 0, status: 'ok', note: '', assignees: {}, stages: defaultStages()
  }, emptyModules());
  
  proj.pct = pctOf(proj);
  await db.createProject(proj);

  await db.addUpdate({
    at: Date.now(),
    role: req.session.role,
    roleName: req.session.name,
    projectId: id,
    projectName: name,
    stage: 1,
    text: `${req.session.name} started a new project: ${name} — assign it to your team to begin`
  });

  res.json({
    ok: true,
    project: await db.getProject(id),
    updates: await db.getUpdatesList(15)
  });
});

// Advance Project stage
app.post('/api/projects/:id/advance', async (req, res) => {
  if (!req.session) return res.status(401).json({ error: 'auth' });
  const id = req.params.id;
  const proj = await db.getProject(id);
  
  if (!proj) return res.status(404).json({ error: 'Project not found' });
  if (!canAdvanceStage(req.session, proj)) {
    return res.status(403).json({ error: 'This task is not assigned to you, or your role cannot update this stage' });
  }

  await doAdvance(proj, req.session);

  res.json({
    ok: true,
    project: await db.getProject(id),
    updates: await db.getUpdatesList(15)
  });
});

// Assign project team
app.post('/api/projects/:id/assign', async (req, res) => {
  if (!req.session) return res.status(401).json({ error: 'auth' });
  if (req.session.role !== 'md') return res.status(403).json({ error: 'Only the Managing Director can assign teams' });

  const id = req.params.id;
  const proj = await db.getProject(id);
  if (!proj) return res.status(404).json({ error: 'Project not found' });

  const team = (req.body.team || '').trim();
  if (!team) return res.status(400).json({ error: 'Team is required' });

  await db.assignProjectTeam(id, team);

  await db.addUpdate({
    at: Date.now(),
    role: req.session.role,
    roleName: req.session.name,
    projectId: proj.id,
    projectName: proj.name,
    stage: proj.stage,
    text: `${req.session.name} assigned ${team} to ${proj.name}`
  });

  res.json({
    ok: true,
    project: await db.getProject(id),
    updates: await db.getUpdatesList(15)
  });
});

// Assign project stage person
app.post('/api/projects/:id/assign-stage', async (req, res) => {
  if (!req.session) return res.status(401).json({ error: 'auth' });
  if (req.session.role !== 'md') return res.status(403).json({ error: 'Only the Managing Director can assign people to tasks' });

  const id = req.params.id;
  const proj = await db.getProject(id);
  if (!proj) return res.status(404).json({ error: 'Project not found' });

  const stageId = (req.body.stageId || '').trim();
  const person = (req.body.person || '').trim();
  const stageObj = (proj.stages || []).find(x => x.id === stageId);
  if (!stageObj) return res.status(400).json({ error: 'Invalid stage' });

  await db.assignProjectStagePerson(id, stageId, person);

  await db.addUpdate({
    at: Date.now(),
    role: req.session.role,
    roleName: req.session.name,
    projectId: proj.id,
    projectName: proj.name,
    stage: proj.stage,
    text: `${req.session.name} assigned ${person || 'no one'} to ${stageObj.name} on ${proj.name}`
  });

  res.json({
    ok: true,
    project: await db.getProject(id),
    updates: await db.getUpdatesList(15)
  });
});

// Add Stage
app.post('/api/projects/:id/stage/add', async (req, res) => {
  if (!req.session) return res.status(401).json({ error: 'auth' });
  if (!canEditProcess(req.session)) return res.status(403).json({ error: 'Only the Supervisor or Managing Director can edit the process' });

  const id = req.params.id;
  const proj = await db.getProject(id);
  if (!proj) return res.status(404).json({ error: 'Project not found' });

  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Step name is required' });

  const afterStageId = (req.body.afterStageId || '').trim();
  const newStage = { id: newStageId(), name, desc: '', kind: null, fields: [] };
  
  let insertAt = proj.stages.length;
  if (afterStageId === 'start') {
    insertAt = 0;
  } else if (afterStageId) {
    const idx = proj.stages.findIndex(x => x.id === afterStageId);
    if (idx >= 0) insertAt = idx + 1;
  }

  await db.addProjectStage(id, newStage, insertAt);

  // Update projects current stage indicator if shifted
  if (insertAt <= proj.stage - 1) {
    await db.updateProjectProgress(id, proj.stage + 1, proj.sub, proj.status, proj.note, proj.pct);
  }

  await db.addUpdate({
    at: Date.now(),
    role: req.session.role,
    roleName: req.session.name,
    projectId: proj.id,
    projectName: proj.name,
    stage: proj.stage,
    text: `${req.session.name} added a new step "${name}" to the process on ${proj.name}`
  });

  res.json({
    ok: true,
    project: await db.getProject(id),
    updates: await db.getUpdatesList(15)
  });
});

// Rename Stage
app.post('/api/projects/:id/stage/rename', async (req, res) => {
  if (!req.session) return res.status(401).json({ error: 'auth' });
  if (!canEditProcess(req.session)) return res.status(403).json({ error: 'Only the Supervisor or Managing Director can edit the process' });

  const id = req.params.id;
  const proj = await db.getProject(id);
  if (!proj) return res.status(404).json({ error: 'Project not found' });

  const stageId = (req.body.stageId || '').trim();
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Name is required' });

  const stageObj = (proj.stages || []).find(x => x.id === stageId);
  if (!stageObj) return res.status(404).json({ error: 'Stage not found' });

  const oldName = stageObj.name;
  await db.renameProjectStage(id, stageId, name);

  await db.addUpdate({
    at: Date.now(),
    role: req.session.role,
    roleName: req.session.name,
    projectId: proj.id,
    projectName: proj.name,
    stage: proj.stage,
    text: `${req.session.name} renamed "${oldName}" to "${name}" on ${proj.name}`
  });

  res.json({
    ok: true,
    project: await db.getProject(id),
    updates: await db.getUpdatesList(15)
  });
});

// Add Field to Stage
app.post('/api/projects/:id/stage/field/add', async (req, res) => {
  if (!req.session) return res.status(401).json({ error: 'auth' });
  if (!canEditProcess(req.session)) return res.status(403).json({ error: 'Only the Supervisor or Managing Director can edit the process' });

  const id = req.params.id;
  const proj = await db.getProject(id);
  if (!proj) return res.status(404).json({ error: 'Project not found' });

  const stageId = (req.body.stageId || '').trim();
  const label = (req.body.label || '').trim();
  const type = req.body.type === 'file' ? 'file' : 'text';
  if (!label) return res.status(400).json({ error: 'Field label is required' });

  const stageObj = (proj.stages || []).find(x => x.id === stageId);
  if (!stageObj) return res.status(404).json({ error: 'Stage not found' });

  const field = { id: newFieldId(), label, type, value: '', origName: '' };
  await db.addStageField(id, stageId, field);

  await db.addUpdate({
    at: Date.now(),
    role: req.session.role,
    roleName: req.session.name,
    projectId: proj.id,
    projectName: proj.name,
    stage: proj.stage,
    text: `${req.session.name} added a ${type === 'file' ? 'document' : 'field'} "${label}" to "${stageObj.name}" on ${proj.name}`
  });

  res.json({
    ok: true,
    project: await db.getProject(id),
    updates: await db.getUpdatesList(15)
  });
});

// Remove Field from Stage
app.post('/api/projects/:id/stage/field/remove', async (req, res) => {
  if (!req.session) return res.status(401).json({ error: 'auth' });
  if (!canEditProcess(req.session)) return res.status(403).json({ error: 'Only the Supervisor or Managing Director can edit the process' });

  const id = req.params.id;
  const proj = await db.getProject(id);
  if (!proj) return res.status(404).json({ error: 'Project not found' });

  const stageId = (req.body.stageId || '').trim();
  const fieldId = (req.body.fieldId || '').trim();

  await db.removeStageField(id, stageId, fieldId);

  res.json({
    ok: true,
    project: await db.getProject(id),
    updates: await db.getUpdatesList(15)
  });
});

// Update Field Value
app.post('/api/projects/:id/stage/field/value', async (req, res) => {
  if (!req.session) return res.status(401).json({ error: 'auth' });
  const id = req.params.id;
  const proj = await db.getProject(id);
  if (!proj) return res.status(404).json({ error: 'Project not found' });

  const stageId = (req.body.stageId || '').trim();
  const fieldId = (req.body.fieldId || '').trim();
  const value = (req.body.value || '').toString();

  const stageObj = (proj.stages || []).find(x => x.id === stageId);
  if (!stageObj) return res.status(404).json({ error: 'Stage not found' });
  if (!canTouchStage(req.session, proj, stageObj)) {
    return res.status(403).json({ error: 'This stage is not assigned to you' });
  }

  await db.updateStageFieldValue(id, stageId, fieldId, value, '');

  await db.addUpdate({
    at: Date.now(),
    role: req.session.role,
    roleName: req.session.name,
    projectId: proj.id,
    projectName: proj.name,
    stage: proj.stage,
    text: `${req.session.name} filled "${stageObj.fields.find(f => f.id === fieldId)?.label || 'field'}" on ${proj.name}`
  });

  res.json({
    ok: true,
    project: await db.getProject(id),
    updates: await db.getUpdatesList(15)
  });
});

// File upload endpoint for stage fields
app.post('/api/projects/:id/stage/field/upload', upload.single('file'), async (req, res) => {
  if (!req.session) return res.status(401).json({ error: 'auth' });
  const id = req.params.id;
  const proj = await db.getProject(id);
  if (!proj) return res.status(404).json({ error: 'Project not found' });

  const stageId = req.body.stageId;
  const fieldId = req.body.fieldId;
  const file = req.file;

  if (!file) return res.status(400).json({ error: 'No file uploaded or file rejected' });

  const stageObj = (proj.stages || []).find(x => x.id === stageId);
  if (!stageObj) return res.status(400).json({ error: 'Invalid stage' });
  if (!canTouchStage(req.session, proj, stageObj)) {
    return res.status(403).json({ error: 'This stage is not assigned to you' });
  }

  const field = (stageObj.fields || []).find(f => f.id === fieldId);
  if (!field) return res.status(400).json({ error: 'Invalid field' });

  // Update DB with the safe name generated by Multer
  await db.updateStageFieldValue(id, stageId, fieldId, file.filename, file.originalname);

  await db.addUpdate({
    at: Date.now(),
    role: req.session.role,
    roleName: req.session.name,
    projectId: proj.id,
    projectName: proj.name,
    stage: proj.stage,
    text: `${req.session.name} uploaded "${file.originalname}" for "${field.label}" on ${proj.name}`
  });

  res.json({
    ok: true,
    project: await db.getProject(id),
    updates: await db.getUpdatesList(15)
  });
});

// Serve uploaded files securely
app.get('/api/uploads/:fname', (req, res) => {
  if (!req.session) return res.status(401).json({ error: 'auth' });
  const fname = req.params.fname;
  const fp = path.join(UPLOADS, fname);
  
  if (!fp.startsWith(UPLOADS) || !fs.existsSync(fp)) {
    return res.status(404).send('File not found');
  }
  res.sendFile(fp);
});

// Assign Module Role
app.post('/api/projects/:id/assign-module', async (req, res) => {
  if (!req.session) return res.status(401).json({ error: 'auth' });
  if (req.session.role !== 'md') return res.status(403).json({ error: 'Only the Managing Director can assign work areas' });

  const id = req.params.id;
  const proj = await db.getProject(id);
  if (!proj) return res.status(404).json({ error: 'Project not found' });

  const module = (req.body.module || '').trim();
  const role = (req.body.role || '').trim();

  if (!MODULES.includes(module)) return res.status(400).json({ error: 'Invalid module' });
  if (role && !ROLE_NAME[role]) return res.status(400).json({ error: 'Invalid role' });

  await db.assignProjectModuleRole(id, module, role);

  const text = role
    ? `${req.session.name} assigned ${MODULE_LABEL[module]} on ${proj.name} to ${ROLE_NAME[role]}`
    : `${req.session.name} unassigned ${MODULE_LABEL[module]} on ${proj.name}`;

  await db.addUpdate({
    at: Date.now(),
    role: req.session.role,
    roleName: req.session.name,
    projectId: proj.id,
    projectName: proj.name,
    stage: proj.stage,
    module,
    moduleRole: role,
    text
  });

  res.json({
    ok: true,
    project: await db.getProject(id),
    updates: await db.getUpdatesList(15)
  });
});

// Add Item to Module (Materials/Payments/Documents)
app.post('/api/projects/:id/module-item/add', async (req, res) => {
  if (!req.session) return res.status(401).json({ error: 'auth' });
  const id = req.params.id;
  const proj = await db.getProject(id);
  if (!proj) return res.status(404).json({ error: 'Project not found' });

  const module = (req.body.module || '').trim();
  if (!['materials', 'payments', 'documents'].includes(module)) return res.status(400).json({ error: 'Invalid module' });
  if (!canEditModule(req.session, proj, module)) return res.status(403).json({ error: 'This work area is not assigned to you' });

  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Name is required' });

  const item = { name, status: 'Pending' };
  if (module === 'payments') {
    item.amount = (req.body.amount || '').trim() || '—';
  }
  if (module === 'materials') {
    item.qty = (req.body.qty || '').trim();
    item.unit = (req.body.unit || '').trim();
    item.note = (req.body.note || '').trim();
  }
  if (module === 'documents') {
    item.docType = (req.body.docType || '').trim();
    item.note = (req.body.note || '').trim();
  }

  await db.addModuleItem(id, module, item);

  await db.addUpdate({
    at: Date.now(),
    role: req.session.role,
    roleName: req.session.name,
    projectId: proj.id,
    projectName: proj.name,
    stage: proj.stage,
    text: `${req.session.name} added to ${MODULE_LABEL[module]} on ${proj.name}: ${name}`
  });

  res.json({
    ok: true,
    project: await db.getProject(id),
    updates: await db.getUpdatesList(15)
  });
});

// Toggle Module Item Status
app.post('/api/projects/:id/module-item/toggle', async (req, res) => {
  if (!req.session) return res.status(401).json({ error: 'auth' });
  const id = req.params.id;
  const proj = await db.getProject(id);
  if (!proj) return res.status(404).json({ error: 'Project not found' });

  const module = (req.body.module || '').trim();
  const idx = parseInt(req.body.idx, 10);
  if (!['materials', 'payments', 'documents'].includes(module)) return res.status(400).json({ error: 'Invalid module' });
  if (!canEditModule(req.session, proj, module)) return res.status(403).json({ error: 'This work area is not assigned to you' });

  const itemsList = proj[module] || [];
  const item = itemsList[idx];
  if (!item) return res.status(404).json({ error: 'Item not found' });

  await db.toggleModuleItem(id, module, idx);

  const newStatus = item.status === 'Done' ? 'Pending' : 'Done';
  await db.addUpdate({
    at: Date.now(),
    role: req.session.role,
    roleName: req.session.name,
    projectId: proj.id,
    projectName: proj.name,
    stage: proj.stage,
    text: `${req.session.name} marked "${item.name}" ${newStatus} on ${proj.name}`
  });

  res.json({
    ok: true,
    project: await db.getProject(id),
    updates: await db.getUpdatesList(15)
  });
});

// Create Purchase Order
app.post('/api/projects/:id/po/create', async (req, res) => {
  if (!req.session) return res.status(401).json({ error: 'auth' });
  if (!canEditPO(req.session)) return res.status(403).json({ error: 'Only the Supervisor or Managing Director can raise a purchase order' });

  const id = req.params.id;
  const proj = await db.getProject(id);
  if (!proj) return res.status(404).json({ error: 'Project not found' });

  const vendor = {
    name: (req.body.vendor && req.body.vendor.name || '').trim(),
    address: (req.body.vendor && req.body.vendor.address || '').trim(),
    phone: (req.body.vendor && req.body.vendor.phone || '').trim(),
    email: (req.body.vendor && req.body.vendor.email || '').trim()
  };
  const shipTo = {
    name: (req.body.shipTo && req.body.shipTo.name || '').trim(),
    address: (req.body.shipTo && req.body.shipTo.address || '').trim(),
    phone: (req.body.shipTo && req.body.shipTo.phone || '').trim(),
    email: (req.body.shipTo && req.body.shipTo.email || '').trim()
  };
  const items = Array.isArray(req.body.items) ? req.body.items
    .map(it => ({ name: (it.name || '').trim(), desc: (it.desc || '').trim(), qty: Number(it.qty) || 0, unitPrice: Number(it.unitPrice) || 0 }))
    .filter(it => it.name) : [];

  if (!vendor.name) return res.status(400).json({ error: 'Vendor name is required' });
  if (!items.length) return res.status(400).json({ error: 'At least one item is required' });

  const po = {
    id: await nextPoId(), vendor, shipTo, items,
    requestNo: (req.body.requestNo || '').trim(),
    shipVia: (req.body.shipVia || '').trim(),
    fob: (req.body.fob || '').trim(),
    shippingTerms: (req.body.shippingTerms || '').trim(),
    taxPercent: Number(req.body.taxPercent) || 0,
    shippingFee: Number(req.body.shippingFee) || 0,
    status: 'Draft', raisedBy: req.session.name,
    date: new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
  };

  await db.createPurchaseOrder(id, po);

  await db.addUpdate({
    at: Date.now(),
    role: req.session.role,
    roleName: req.session.name,
    projectId: proj.id,
    projectName: proj.name,
    stage: proj.stage,
    text: `${req.session.name} raised ${po.id} on ${proj.name} — ${vendor.name}`
  });

  const emailResult = await sendPoEmail(proj, po);
  if (emailResult.sent) {
    await db.updatePurchaseOrderEmail(id, po.id, vendor.email);
    await db.addUpdate({
      at: Date.now(),
      role: req.session.role,
      roleName: req.session.name,
      projectId: proj.id,
      projectName: proj.name,
      stage: proj.stage,
      text: `${po.id} emailed to ${vendor.name} (${vendor.email})`
    });
  }

  res.json({
    ok: true,
    project: await db.getProject(id),
    updates: await db.getUpdatesList(15),
    email: emailResult
  });
});

// Serve Purchase Order PDF
app.get('/api/projects/:id/po/:poId/pdf', async (req, res) => {
  if (!req.session) return res.status(401).json({ error: 'auth' });
  
  const id = req.params.id;
  const poId = req.params.poId;
  const proj = await db.getProject(id);
  if (!proj) return res.status(404).send('Project not found');

  const po = (proj.po || []).find(x => x.id === poId);
  if (!po) return res.status(404).send('PO not found');

  try {
    const pdfBuf = poPdfBuffer(proj, po);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${po.id}.pdf"`);
    res.send(pdfBuf);
  } catch (e) {
    logError('poPdfBuffer', e);
    res.status(500).json({ error: 'Could not generate the PDF right now — please try again.' });
  }
});

// Update Purchase Order Status
app.post('/api/projects/:id/po/status', async (req, res) => {
  if (!req.session) return res.status(401).json({ error: 'auth' });
  if (!canEditPO(req.session)) return res.status(403).json({ error: 'Only the Supervisor or Managing Director can update a purchase order' });

  const id = req.params.id;
  const proj = await db.getProject(id);
  if (!proj) return res.status(404).json({ error: 'Project not found' });

  const poId = (req.body.poId || '').trim();
  const po = (proj.po || []).find(x => x.id === poId);
  if (!po) return res.status(404).json({ error: 'PO not found' });

  const curIdx = PO_STATUS.indexOf(po.status);
  if (curIdx < PO_STATUS.length - 1) {
    const nextStatus = PO_STATUS[curIdx + 1];
    await db.updatePurchaseOrderStatus(id, poId, nextStatus);

    await db.addUpdate({
      at: Date.now(),
      role: req.session.role,
      roleName: req.session.name,
      projectId: proj.id,
      projectName: proj.name,
      stage: proj.stage,
      text: `${req.session.name} marked ${po.id} on ${proj.name} as ${nextStatus}`
    });
  }

  res.json({
    ok: true,
    project: await db.getProject(id),
    updates: await db.getUpdatesList(15)
  });
});

// Notify MD
app.post('/api/projects/:id/notify', async (req, res) => {
  if (!req.session) return res.status(401).json({ error: 'auth' });
  const id = req.params.id;
  const proj = await db.getProject(id);
  if (!proj) return res.status(404).json({ error: 'Project not found' });

  const curStage = (proj.stages || [])[proj.stage - 1];
  const message = (req.body.message || '').trim() || `Update on ${curStage ? curStage.name : 'current stage'}`;

  await db.addUpdate({
    at: Date.now(),
    role: req.session.role,
    roleName: req.session.name,
    projectId: proj.id,
    projectName: proj.name,
    stage: proj.stage,
    notify: true,
    text: `${req.session.name} notified the MD — ${proj.name}: ${message}`
  });

  res.json({
    ok: true,
    updates: await db.getUpdatesList(15)
  });
});

// Reset database seeds
app.post('/api/reset', async (req, res) => {
  if (!req.session) return res.status(401).json({ error: 'auth' });
  await db.clearAllProjects();
  res.json({ ok: true });
});

// Catch-all route -> redirect to home
app.use((req, res) => {
  res.redirect('/');
});

// Global error handler
app.use((err, req, res, next) => {
  logError(`express-request ${req.method} ${req.url}`, err);
  if (res.headersSent) return;
  
  const tooLarge = /too large|file size/i.test(err.message || '');
  res.status(tooLarge ? 413 : 500).json({
    error: tooLarge
      ? 'Upload file or request body is too large (max 15MB for files, 2MB for JSON)'
      : err.message || 'Something went wrong on our end — please try again.'
  });
});

// On Vercel, this file is loaded as a serverless function handler (see vercel.json) — it must
// export `app` and must NOT call app.listen(), since Vercel's runtime owns the actual HTTP server.
// Locally (or on Railway/Render/etc.), VERCEL is unset, so we start a normal persistent server.
if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`\n  Sunworld Command Center (Production-Ready) → http://localhost:${PORT}`);
    // These reflect the ACTUAL seeded passwords (env var override, else the fallback literal below) —
    // previously this banner printed unrelated hardcoded strings that never matched a real login.
    console.log(`  MD login: admin / ${process.env.ADMIN_PASSWORD || 'admin123'}`);
    console.log(`  Site Manager login: sitemanager / ${process.env.SITEMANAGER_PASSWORD || 'sitemanager123'}`);
    console.log(`  Supervisor login: supervisor / ${process.env.SUPERVISOR_PASSWORD || 'supervisor123'}`);
    console.log(`  Coordinator login: coordinator / ${process.env.COORDINATOR_PASSWORD || 'coordinator123'}\n`);
  });
}

module.exports = app;
