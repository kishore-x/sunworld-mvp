// Sunworld Command Center — MVP server (zero dependencies, Node core only)
// Roles: MD (oversees everything) + Coordinator (runs Stages 1-5,7-10 for every service)
// + Site Manager / Supervisor (named individuals — only see work the MD assigned to them at Site Execution).
// Every team update flows into shared project state, which the MD dashboard reads live — across all 5 services.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;
const PUB = path.join(ROOT, 'public');
const DB = path.join(ROOT, 'db.json');
const LOGS = path.join(ROOT, 'logs');
const PORT = process.env.PORT || 4173;
const MAX_BODY_BYTES = 2 * 1024 * 1024;      // JSON request bodies
const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;   // multipart file uploads
const ALLOWED_UPLOAD_EXT = ['.pdf','.jpg','.jpeg','.png','.doc','.docx','.xls','.xlsx','.txt','.webp'];
// Uploaded documents live in memory only (same "no filesystem dependency" reasoning as the DB
// above) — a Map from generated filename to its raw bytes, served straight back on request.
const uploadStore = new Map();

// ---- Crash-proofing: log real errors to a file so an overnight failure leaves a trace, and never
// let one bad request or a stray unhandled error take the whole process down.
function logError(context, err){
  try{
    fs.mkdirSync(LOGS, {recursive:true});
    const line = `[${new Date().toISOString()}] ${context}: ${err && err.stack || err}\n`;
    fs.appendFileSync(path.join(LOGS,'error.log'), line);
  }catch{ /* logging must never itself throw */ }
  console.error(`[${context}]`, err);
}
process.on('uncaughtException', err => logError('uncaughtException', err));
process.on('unhandledRejection', err => logError('unhandledRejection', err));

// ---- Outbound email (Resend) — set RESEND_API_KEY before the vendor-email feature will actually send.
// Resend's API is a single JSON POST, so this uses Node's built-in fetch — no npm install needed.
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const RESEND_FROM = process.env.RESEND_FROM || 'onboarding@resend.dev';
async function sendPoEmail(proj, po){
  if(!RESEND_API_KEY) return { sent:false, reason:'RESEND_API_KEY not configured' };
  if(!po.vendor.email) return { sent:false, reason:'Vendor has no email address' };
  try{
    const pdf = poPdfBuffer(proj, po);
    const html = `<p>Dear ${esc(po.vendor.name)},</p>
      <p>Please find attached Purchase Order <b>${esc(po.id)}</b> from ${esc(COMPANY.name)} for project <b>${esc(proj.name)}</b>.</p>
      <p>Ship Via: ${esc(po.shipVia||'-')}<br>FOB: ${esc(po.fob||'-')}<br>Shipping Terms: ${esc(po.shippingTerms||'-')}</p>
      <p>Regards,<br>${esc(COMPANY.name)}</p>`;
    const r = await fetch('https://api.resend.com/emails', {
      method:'POST',
      headers:{ 'Authorization':`Bearer ${RESEND_API_KEY}`, 'Content-Type':'application/json' },
      body: JSON.stringify({
        from: RESEND_FROM,
        to: po.vendor.email,
        subject: `Purchase Order ${po.id} — ${COMPANY.name}`,
        html,
        attachments: [{ filename: `${po.id}.pdf`, content: pdf.toString('base64') }]
      })
    });
    if(!r.ok){ const t = await r.text(); return { sent:false, reason:`Resend error: ${t.slice(0,200)}` }; }
    return { sent:true };
  }catch(e){ return { sent:false, reason:e.message }; }
}

// ---- Users / roles (demo credentials — password step removed, pick a role and go straight in) ----
// canGeneral = can act on any non-gated stage, department-wide, no per-stage assignment needed.
// canSiteExecution = can act on the 'site-execution'-kind stage, but ONLY once the MD has
//          assigned that stage to this login's exact `person` name (checked server-side).
// person = for named-individual logins, the exact name string the MD uses in the per-task
//          "Assign" dropdown.
const USERS = {
  admin:       { role:'md',          name:'Managing Director', canGeneral:true, canSiteExecution:true },
  sitemanager: { role:'sitemanager', name:'Site Manager',      canGeneral:false, canSiteExecution:true, person:'Site Manager' },
  // Supervisor now builds the whole project plan once the MD starts a new client — department-wide
  // for every stage except Site Execution, which still requires the MD to explicitly assign
  // "Supervisor" (or Site Manager) by name before they can act on it.
  supervisor:  { role:'supervisor',  name:'Supervisor',        canGeneral:true, canSiteExecution:true, person:'Supervisor' },
  coordinator: { role:'coordinator', name:'Project Coordinator', canGeneral:true, canSiteExecution:false },
};

const STAGE_NAME = ['Enquiry & Survey','Quotation','Work Order','Drawings','Procurement','Site Execution','Quality / QC','Client Update','Invoicing','Handover'];
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
const STEEL_SUB  = ['Foundation','Column & Beam Erection','Roof Purlin & Sheeting','Wall Cladding','MEP Rough-in','Flooring','Finishing & Handover'];
const EPOXY_SUB  = ['Surface Preparation','Primer Coat','Base Coat','Top Coat','Cure & Inspection','Handover'];
const VALID_SERVICES = ['warehouse','steel','epoxy','interior','exterior'];
function subFor(service){ return service==='epoxy' ? EPOXY_SUB : STEEL_SUB; }

// The 10-stage process is now editable per-project — the assigned executor (Supervisor, or MD)
// can insert a custom stage anywhere, rename any stage, and attach custom fields (text or a
// document upload) to any stage. `kind:'site-execution'` marks the one stage that keeps its
// special sub-stage sequence and person-gating, tracked by a stable id (not position number) so
// inserting stages elsewhere never breaks it.
function newStageId(){ return 'st-'+crypto.randomBytes(4).toString('hex'); }
function newFieldId(){ return 'fld-'+crypto.randomBytes(3).toString('hex'); }
function defaultStages(){
  return STAGE_NAME.map((name,i)=>({ id:`st-${i+1}`, name, desc:STAGE_DOC[i], kind: i===5?'site-execution':null, fields:[] }));
}
function canEditProcess(s){ return s.role==='md' || s.role==='supervisor'; }
function canAdvanceStage(s, proj){
  const cur = (proj.stages||[])[proj.stage-1]; if(!cur) return false;
  if(s.role==='md') return true;
  if(cur.kind==='site-execution') return !!(s.canSiteExecution && proj.assignees && proj.assignees[cur.id]===s.person);
  return !!s.canGeneral;
}
function canTouchStage(s, proj, stageObj){
  if(s.role==='md') return true;
  if(stageObj.kind==='site-execution') return !!(s.canSiteExecution && proj.assignees && proj.assignees[stageObj.id]===s.person);
  return !!s.canGeneral;
}

// A project has 4 work areas the MD can hand out separately: the 10-stage progress tracker,
// materials/procurement, payment milestones, and the document center. Each starts empty and
// unassigned — nothing is fabricated. MD assigns each area to a role; only the MD or that role
// can add/update items in it.
const MODULES = ['progress','materials','payments','documents'];
const MODULE_LABEL = {progress:'Project Progress', materials:'Materials & Procurement', payments:'Payment Milestones', documents:'Document Center'};
const ROLE_NAME = {coordinator:'Project Coordinator', sitemanager:'Site Manager', supervisor:'Supervisor'};
function canEditModule(s, proj, module){
  if(s.role==='md') return true;
  return !!(proj.moduleAssignees && proj.moduleAssignees[module] === s.role);
}
function emptyModules(){ return { materials:[], payments:[], documents:[], po:[], moduleAssignees:{progress:'',materials:'',payments:'',documents:''} }; }

// Purchase Orders: raised against a vendor/supplier for materials, separate from the client-facing
// modules above. Access is fixed to Supervisor + MD (not MD-assignable like the other modules) —
// every project's Supervisor can raise a PO, and the MD can too/oversee all of them.
const PO_STATUS = ['Draft','Sent','Acknowledged','Received'];
function canEditPO(s){ return s.role==='md' || s.role==='supervisor'; }
function nextPoId(){
  let max=0;
  projectsArray().forEach(pr=>{ (pr.po||[]).forEach(po=>{ const m=(po.id||'').match(/-(\d+)$/); if(m){ const n=parseInt(m[1],10); if(n>max) max=n; } }); });
  return `PO-2026-${String(max+1).padStart(3,'0')}`;
}
const COMPANY = { name:'Sunworld Infra Pvt Ltd', address:'Coimbatore, Tamil Nadu, India', phone:'+91 98765 43210', email:'procurement@sunworldinfra.com', web:'www.sunworldinfra.com' };
function poTotals(po){
  const items = po.items||[];
  const sub = items.reduce((s,it)=> s + (Number(it.qty)||0)*(Number(it.unitPrice)||0), 0);
  const tax = sub * ((Number(po.taxPercent)||0)/100);
  const ship = Number(po.shippingFee)||0;
  return { sub, tax, ship, total: sub+tax+ship };
}
function esc(v){ return String(v==null?'':v).replace(/[&<>"]/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }

// ---- Hand-rolled PDF writer (no library, no npm) ----
// PDF's base-14 fonts (Helvetica) don't include the ₹ glyph, so amounts use "Rs." here —
// the HTML views elsewhere keep ₹ since browser fonts render it fine.
const NAVY = '0.109 0.227 0.419';
function pdfEsc(s){ return String(s==null?'':s).replace(/\\/g,'\\\\').replace(/\(/g,'\\(').replace(/\)/g,'\\)'); }
function pdfMoney(n){ return 'Rs. '+Number(n||0).toLocaleString('en-IN',{minimumFractionDigits:2,maximumFractionDigits:2}); }
function poPdfBuffer(proj, po){
  const t = poTotals(po);
  const v = po.vendor||{}, sh = po.shipTo||{};
  const ops = [];
  const text = (x,y,size,s,opts={}) => {
    const font = opts.bold ? '/F2' : '/F1';
    const color = opts.color || '0 0 0';
    ops.push(`q ${color} rg BT ${font} ${size} Tf 1 0 0 1 ${x} ${y} Tm (${pdfEsc(s)}) Tj ET Q`);
  };
  const rule = (x1,y,x2,w,color) => ops.push(`q ${color||NAVY} RG ${w} w ${x1} ${y} m ${x2} ${y} l S Q`);
  const rectFill = (x,y,w,h,color) => ops.push(`q ${color} rg ${x} ${y} ${w} ${h} re f Q`);

  const L = 40, R = 555; // left/right content margins on an A4 (595pt wide) page
  rectFill(0, 822, 595, 10, NAVY);
  text(L, 775, 24, 'PURCHASE ORDER', {bold:true, color:NAVY});

  // company block (left) + PO meta (right)
  let y = 748;
  text(L, y, 11, COMPANY.name, {bold:true}); y -= 14;
  [COMPANY.address, COMPANY.phone, COMPANY.email, COMPANY.web].forEach(l=>{ text(L, y, 10, l); y -= 13; });
  const metaX = 380, metaValX = 460;
  let my = 748;
  [['PO Number',po.id], ['Date',po.date||''], ['Ship Via',po.shipVia||'-'], ['FOB',po.fob||'-'], ['Shipping Terms',po.shippingTerms||'-'], ['Status',po.status]].forEach(([k,val])=>{
    text(metaX, my, 9.5, k, {color:'0.35 0.35 0.35'}); text(metaValX, my, 9.5, String(val), {bold:true}); my -= 15;
  });

  y = Math.min(y, my) - 12;
  rule(L, y, R, 1.4); y -= 20;
  const vY0 = y;
  text(L, y, 10, 'VENDOR', {bold:true, color:NAVY}); y -= 15;
  text(L, y, 10.5, v.name||'', {bold:true}); y -= 13;
  [v.address, v.phone, v.email].filter(Boolean).forEach(l=>{ text(L, y, 9.5, l); y -= 13; });
  let sy = vY0;
  text(metaX, sy, 10, 'SHIP TO', {bold:true, color:NAVY}); sy -= 15;
  text(metaX, sy, 10.5, sh.name||proj.name, {bold:true}); sy -= 13;
  (sh.address ? [sh.address] : [proj.site]).concat([sh.phone, sh.email].filter(Boolean)).forEach(l=>{ text(metaX, sy, 9.5, l); sy -= 13; });

  y = Math.min(y, sy) - 8;
  rule(L, y, R, 1.4); y -= 24;

  const colItem=L, colQty=310, colPrice=380, colTotal=475;
  text(colItem, y, 9.5, 'ITEM DETAILS', {bold:true, color:NAVY});
  text(colQty, y, 9.5, 'QTY', {bold:true, color:NAVY});
  text(colPrice, y, 9.5, 'UNIT PRICE', {bold:true, color:NAVY});
  text(colTotal, y, 9.5, 'TOTAL', {bold:true, color:NAVY});
  y -= 8; rule(L, y, R, 1.4); y -= 18;

  (po.items||[]).forEach(it=>{
    const lineTotal = (Number(it.qty)||0)*(Number(it.unitPrice)||0);
    text(colItem, y, 10, it.name||'', {bold:true});
    text(colQty, y, 10, String(it.qty||0));
    text(colPrice, y, 10, pdfMoney(it.unitPrice));
    text(colTotal, y, 10, pdfMoney(lineTotal));
    y -= 13;
    if(it.desc){ text(colItem, y, 8.5, it.desc, {color:'0.45 0.45 0.45'}); y -= 13; }
    y -= 3; rule(L, y+9, R, 0.6, '0.85 0.85 0.85'); y -= 8;
    if(y < 110) return; // stop rather than overflow the page (demo-scale POs only)
  });

  y -= 12;
  const sumLabelX = 400, sumValX = 555, sumX0 = 380;
  const sumLine = (label, val, opts={}) => {
    text(sumLabelX, y, opts.size||10, label, {color: opts.color});
    text(sumValX-70, y, opts.size||10, val, {bold:opts.bold, color:opts.color});
    y -= (opts.gap||16);
  };
  sumLine('Sub Total', pdfMoney(t.sub));
  sumLine(`Tax${po.taxPercent?` (${po.taxPercent}%)`:''}`, pdfMoney(t.tax));
  sumLine('Shipping Fee', pdfMoney(t.ship));
  rule(sumX0, y+10, R, 1.4);
  sumLine('Total', pdfMoney(t.total), {bold:true, color:NAVY, size:13, gap:0});

  const content = ops.join('\n');
  const objs = [];
  objs.push('1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n');
  objs.push('2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n');
  objs.push('3 0 obj << /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /MediaBox [0 0 595 842] /Contents 6 0 R >> endobj\n');
  objs.push('4 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj\n');
  objs.push('5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >> endobj\n');
  objs.push(`6 0 obj << /Length ${Buffer.byteLength(content,'latin1')} >> stream\n${content}\nendstream endobj\n`);

  let out = '%PDF-1.4\n';
  const offsets = [0];
  objs.forEach(o=>{ offsets.push(Buffer.byteLength(out,'latin1')); out += o; });
  const xrefStart = Buffer.byteLength(out,'latin1');
  out += `xref\n0 ${objs.length+1}\n0000000000 65535 f \n`;
  for(let i=1;i<=objs.length;i++) out += String(offsets[i]).padStart(10,'0') + ' 00000 n \n';
  out += `trailer << /Size ${objs.length+1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  return Buffer.from(out, 'latin1');
}

// ---- Seed data — 28 projects spread across all 5 services ----
// Empty by design — Kishore populates real clients via "+ New Project" in the app.
// (Previously seeded with 28 sample projects across all 5 services for demo purposes.)
const SEED = [];

function pctOf(p){
  const subs = subFor(p.service);
  const stages = p.stages || defaultStages();
  const cur = stages[p.stage-1];
  const isSiteExec = cur && cur.kind==='site-execution';
  const total = Math.max(1, stages.length-1);
  const frac = ((p.stage-1) + (isSiteExec ? p.sub/subs.length : 0)) / total;
  return Math.max(0, Math.min(100, Math.round(frac*100)));
}

// ---- Persistence — pure in-memory, deliberately, for this demo phase ----
// No file writes at all, so this can never crash from a read-only filesystem on any hosting
// platform (Vercel, etc). Trade-off: data resets whenever the process restarts/cold-starts —
// acceptable for a demo; swap this for Supabase when real persistence is actually needed.
function loadDB(){ return {}; }
function saveDB(){ /* in-memory only — nothing to flush to disk */ }
let db = loadDB();
function seedProjects(){ db.projects = {}; SEED.forEach(p=>{ const proj = Object.assign({}, p, emptyModules(), {assignees:{}, stages:defaultStages()}); proj.pct = pctOf(proj); db.projects[p.id] = proj; }); }
if(!db.projects){ seedProjects(); }
if(!db.updates){ db.updates = []; }
if(!db.sessions){ db.sessions = {}; }
saveDB();

function projectsArray(){ return Object.values(db.projects); }
function nextJobId(){
  let max=0;
  Object.keys(db.projects).forEach(id=>{ const m=id.match(/-(\d+)$/); if(m){ const n=parseInt(m[1],10); if(n>max) max=n; } });
  return `SW-2026-${String(max+1).padStart(3,'0')}`;
}

function doAdvance(p, sess){
  let text;
  const subs = subFor(p.service);
  const stages = p.stages;
  const cur = stages[p.stage-1];
  if(cur.kind==='site-execution'){
    if(p.sub < subs.length-1){
      p.sub++;
      text = `advanced ${p.name} to “${subs[p.sub]}”`;
    } else {
      p.sub = 0;
      if(p.stage < stages.length){ p.stage++; text = `completed ${cur.name} on ${p.name} → moved to ${stages[p.stage-1].name}`; }
      else { text = `completed ${cur.name} on ${p.name}`; }
    }
  } else {
    const from = cur.name;
    if(p.stage < stages.length){ p.stage++; text = `completed ${from} on ${p.name} → moved to ${stages[p.stage-1].name}`; }
    else { text = `completed ${from} on ${p.name}`; }
  }
  if(p.note) p.note = '';
  if(p.status !== 'ok') p.status = 'ok';
  p.pct = pctOf(p);
  db.updates.unshift({ at:Date.now(), role:sess.role, roleName:sess.name, projectId:p.id, projectName:p.name, stage:p.stage, text:`${sess.name} ${text}` });
  db.updates = db.updates.slice(0,40);
  return text;
}

// ---- Sessions ----
// Persisted into db.json (db.sessions) alongside project data, so a server restart or crash no
// longer force-logs-out everyone mid-work — only real logout or the 24h expiry does. Kept as an
// in-memory Map for fast per-request lookup, synced to db.sessions on every login/logout.
const SESSION_MAX_AGE_MS = 24*60*60*1000;
const sessions = new Map(); // sid -> {user, role, name, canGeneral, canSiteExecution, person, csrf, createdAt}
function loadSessionsFromDB(){
  const now = Date.now();
  Object.entries(db.sessions||{}).forEach(([sid,s])=>{
    if(s.createdAt && (now - s.createdAt) < SESSION_MAX_AGE_MS) sessions.set(sid, s);
  });
}
function persistSessions(){ db.sessions = Object.fromEntries(sessions); saveDB(); }
loadSessionsFromDB();

function parseCookies(req){
  const h = req.headers.cookie || '';
  return Object.fromEntries(h.split(';').map(v=>v.trim().split('=').map(decodeURIComponent)).filter(a=>a[0]));
}
function getSession(req){ const c=parseCookies(req); return c.sw_sid ? sessions.get(c.sw_sid) : null; }

// ---- CSRF: a random per-session token the client must echo back (header) on every state-changing
// request. Login/logout are exempt (no session yet / clearing it). Cheap double-submit pattern —
// no external library, just a comparison against the session's own stored token.
function requireCsrf(req, session){
  if(!session) return false;
  const token = req.headers['x-csrf-token'];
  return !!token && token === session.csrf;
}
function send(res, code, body, headers={}){ res.writeHead(code, headers); res.end(body); }
function json(res, code, obj, headers={}){ send(res, code, JSON.stringify(obj), Object.assign({'Content-Type':'application/json'}, headers)); }
// Both readers cap total size so a huge or malicious body can't exhaust server memory — the
// request is aborted and the promise rejects once the limit is crossed, rather than buffering
// unbounded data.
// Note: deliberately does NOT call req.destroy() when the limit is crossed — destroying the
// socket mid-parse can throw inside Node's own HTTP internals (observed during testing). Instead
// we just stop buffering (memory stays bounded) and let the request drain naturally, rejecting
// once we know it's oversized so the caller gets a clean 413 rather than the process crashing.
function readBody(req, maxBytes=MAX_BODY_BYTES){
  return new Promise((resolve,reject)=>{
    let d=''; let bytes=0; let tooLarge=false; let settled=false;
    req.on('data',c=>{
      if(tooLarge) return;
      bytes += c.length;
      if(bytes > maxBytes){ tooLarge=true; return; }
      d += c;
    });
    req.on('end',()=>{ if(settled) return; settled=true; tooLarge ? reject(new Error('Request body too large')) : resolve(d); });
    req.on('error', e=>{ if(settled) return; settled=true; reject(e); });
  });
}
function readBodyBuffer(req, maxBytes=MAX_UPLOAD_BYTES){
  return new Promise((resolve,reject)=>{
    const chunks=[]; let bytes=0; let tooLarge=false; let settled=false;
    req.on('data',c=>{
      if(tooLarge) return;
      bytes += c.length;
      if(bytes > maxBytes){ tooLarge=true; chunks.length=0; return; }
      chunks.push(c);
    });
    req.on('end',()=>{ if(settled) return; settled=true; tooLarge ? reject(new Error('Upload too large')) : resolve(Buffer.concat(chunks)); });
    req.on('error', e=>{ if(settled) return; settled=true; reject(e); });
  });
}
// Minimal multipart/form-data parser (no library) — good enough for simple field+file uploads.
function parseMultipart(buffer, boundary){
  const parts = [];
  const boundaryBuf = Buffer.from(`--${boundary}`);
  let start = buffer.indexOf(boundaryBuf) + boundaryBuf.length;
  while(true){
    const next = buffer.indexOf(boundaryBuf, start);
    if(next===-1) break;
    let chunk = buffer.slice(start, next);
    if(chunk.slice(0,2).toString('latin1')==='\r\n') chunk = chunk.slice(2);
    if(chunk.slice(-2).toString('latin1')==='\r\n') chunk = chunk.slice(0,-2);
    const headerEnd = chunk.indexOf('\r\n\r\n');
    if(headerEnd!==-1){
      const headerStr = chunk.slice(0,headerEnd).toString('utf8');
      const data = chunk.slice(headerEnd+4);
      const nameMatch = headerStr.match(/name="([^"]*)"/);
      const filenameMatch = headerStr.match(/filename="([^"]*)"/);
      parts.push({ name: nameMatch?nameMatch[1]:'', filename: filenameMatch?filenameMatch[1]:null, data });
    }
    start = next + boundaryBuf.length;
    if(buffer.slice(start, start+2).toString('latin1')==='--') break;
  }
  return parts;
}

const MIME = { '.html':'text/html','.css':'text/css','.js':'text/javascript','.json':'application/json','.svg':'image/svg+xml','.ico':'image/x-icon','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.pdf':'application/pdf','.doc':'application/msword','.docx':'application/vnd.openxmlformats-officedocument.wordprocessingml.document','.xls':'application/vnd.ms-excel','.xlsx':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
function serveFile(res, fp){ fs.readFile(fp,(e,data)=>{ if(e) return send(res,404,'Not found'); send(res,200,data,{'Content-Type':MIME[path.extname(fp)]||'text/plain'}); }); }

async function handleRequest(req, res){
  const u = new URL(req.url,'http://localhost');
  const p = u.pathname;

  if(p==='/health'){
    return json(res,200,{ok:true, uptimeSeconds:Math.round(process.uptime()), time:new Date().toISOString()});
  }

  // CSRF gate: every state-changing request (POST, logged in) must echo back its session's own
  // token. Login itself is exempt (no session/token exists yet). If there's no session at all,
  // fall through so the route's own auth check returns the more accurate 401.
  if(req.method==='POST' && p.startsWith('/api/') && p!=='/api/login'){
    const s = getSession(req);
    if(s && !requireCsrf(req, s)) return json(res,403,{error:'Invalid or missing CSRF token'});
  }

  // ---- API ----
  if(p==='/api/login' && req.method==='POST'){
    // Password requirement removed for the demo — pick a role and go straight in, no password step.
    const body=await readBody(req); let d={}; try{d=JSON.parse(body)}catch{}
    const key=(d.user||'').toLowerCase().trim();
    const U=USERS[key];
    if(U){
      const sid=crypto.randomBytes(16).toString('hex');
      const csrf=crypto.randomBytes(24).toString('hex');
      sessions.set(sid, {user:key, role:U.role, name:U.name, canGeneral:U.canGeneral, canSiteExecution:U.canSiteExecution, person:U.person, csrf, createdAt:Date.now()});
      persistSessions();
      return json(res,200,{ok:true, role:U.role, name:U.name, csrf}, {'Set-Cookie':`sw_sid=${sid}; Path=/; HttpOnly; Max-Age=86400; SameSite=Lax`});
    }
    return json(res,401,{ok:false, error:'Unknown user'});
  }
  if(p==='/api/logout' && req.method==='POST'){
    const c=parseCookies(req); sessions.delete(c.sw_sid); persistSessions();
    return json(res,200,{ok:true},{'Set-Cookie':'sw_sid=; Path=/; Max-Age=0'});
  }
  if(p==='/api/me'){
    const s=getSession(req); if(!s) return json(res,401,{error:'auth'});
    return json(res,200,{user:s.user, role:s.role, name:s.name, canGeneral:s.canGeneral, canSiteExecution:s.canSiteExecution, person:s.person, csrf:s.csrf});
  }
  if(p==='/api/projects'){
    const s=getSession(req); if(!s) return json(res,401,{error:'auth'});
    return json(res,200,{ projects:projectsArray(), updates:db.updates.slice(0,15) });
  }
  if(p==='/api/projects/create' && req.method==='POST'){
    const s=getSession(req); if(!s) return json(res,401,{error:'auth'});
    if(s.role!=='md') return json(res,403,{error:'Only the Managing Director can start a new project'});
    const body=await readBody(req); let d={}; try{d=JSON.parse(body)}catch{}
    const name=(d.name||'').trim(), site=(d.site||'').trim(), service=(d.service||'').trim();
    if(!name || !site) return json(res,400,{error:'Client name and site are required'});
    if(!VALID_SERVICES.includes(service)) return json(res,400,{error:'Invalid service'});
    const id = nextJobId();
    const start = new Date().toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric'});
    const proj = Object.assign({
      id, service, name, site,
      tag: (d.tag||'').trim() || 'New project',
      val: (d.val||'').trim() || '₹0.0 L',
      team:'Unassigned', start, delivery: (d.delivery||'').trim() || '—',
      stage:1, sub:0, status:'ok', note:'', assignees:{}, stages:defaultStages()
    }, emptyModules());
    proj.pct = pctOf(proj);
    db.projects[id] = proj;
    db.updates.unshift({ at:Date.now(), role:s.role, roleName:s.name, projectId:id, projectName:name, stage:1, text:`${s.name} started a new project: ${name} — assign it to your team to begin` });
    db.updates = db.updates.slice(0,40);
    saveDB();
    return json(res,200,{ ok:true, project:proj, updates:db.updates.slice(0,15) });
  }
  if(p.startsWith('/api/projects/') && p.endsWith('/advance') && req.method==='POST'){
    const s=getSession(req); if(!s) return json(res,401,{error:'auth'});
    const id=p.split('/')[3];
    const proj=db.projects[id]; if(!proj) return json(res,404,{error:'not found'});
    if(!canAdvanceStage(s, proj)) return json(res,403,{error:'This task is not assigned to you, or your role cannot update this stage'});
    doAdvance(proj, s); saveDB();
    return json(res,200,{ ok:true, project:proj, updates:db.updates.slice(0,15) });
  }
  if(p.startsWith('/api/projects/') && p.endsWith('/assign') && req.method==='POST'){
    const s=getSession(req); if(!s) return json(res,401,{error:'auth'});
    if(s.role!=='md') return json(res,403,{error:'Only the Managing Director can assign teams'});
    const id=p.split('/')[3];
    const proj=db.projects[id]; if(!proj) return json(res,404,{error:'not found'});
    const body=await readBody(req); let d={}; try{d=JSON.parse(body)}catch{}
    const team=(d.team||'').trim();
    if(!team) return json(res,400,{error:'team required'});
    proj.team = team;
    db.updates.unshift({ at:Date.now(), role:s.role, roleName:s.name, projectId:proj.id, projectName:proj.name, stage:proj.stage, text:`${s.name} assigned ${team} to ${proj.name}` });
    db.updates = db.updates.slice(0,40);
    saveDB();
    return json(res,200,{ ok:true, project:proj, updates:db.updates.slice(0,15) });
  }
  if(p.startsWith('/api/projects/') && p.endsWith('/assign-stage') && req.method==='POST'){
    const s=getSession(req); if(!s) return json(res,401,{error:'auth'});
    if(s.role!=='md') return json(res,403,{error:'Only the Managing Director can assign people to tasks'});
    const id=p.split('/')[3];
    const proj=db.projects[id]; if(!proj) return json(res,404,{error:'not found'});
    const body=await readBody(req); let d={}; try{d=JSON.parse(body)}catch{}
    const stageId=(d.stageId||'').trim(); const person=(d.person||'').trim();
    const stageObj = (proj.stages||[]).find(x=>x.id===stageId);
    if(!stageObj) return json(res,400,{error:'invalid stage'});
    proj.assignees = proj.assignees || {};
    if(person && person!=='Unassigned'){ proj.assignees[stageId]=person; } else { delete proj.assignees[stageId]; }
    db.updates.unshift({ at:Date.now(), role:s.role, roleName:s.name, projectId:proj.id, projectName:proj.name, stage:proj.stage, text:`${s.name} assigned ${person||'no one'} to ${stageObj.name} on ${proj.name}` });
    db.updates = db.updates.slice(0,40);
    saveDB();
    return json(res,200,{ ok:true, project:proj, updates:db.updates.slice(0,15) });
  }
  if(p.startsWith('/api/projects/') && p.endsWith('/stage/add') && req.method==='POST'){
    const s=getSession(req); if(!s) return json(res,401,{error:'auth'});
    if(!canEditProcess(s)) return json(res,403,{error:'Only the Supervisor or Managing Director can edit the process'});
    const id=p.split('/')[3];
    const proj=db.projects[id]; if(!proj) return json(res,404,{error:'not found'});
    const body=await readBody(req); let d={}; try{d=JSON.parse(body)}catch{}
    const name=(d.name||'').trim(); if(!name) return json(res,400,{error:'Step name is required'});
    const afterStageId=(d.afterStageId||'').trim();
    const newStage = { id:newStageId(), name, desc:'', kind:null, fields:[] };
    let insertAt = proj.stages.length;
    if(afterStageId==='start') insertAt = 0;
    else if(afterStageId){ const idx=proj.stages.findIndex(x=>x.id===afterStageId); if(idx>=0) insertAt = idx+1; }
    proj.stages.splice(insertAt, 0, newStage);
    if(insertAt <= proj.stage-1) proj.stage++;
    proj.pct = pctOf(proj);
    db.updates.unshift({ at:Date.now(), role:s.role, roleName:s.name, projectId:proj.id, projectName:proj.name, stage:proj.stage, text:`${s.name} added a new step "${name}" to the process on ${proj.name}` });
    db.updates = db.updates.slice(0,40);
    saveDB();
    return json(res,200,{ ok:true, project:proj, updates:db.updates.slice(0,15) });
  }
  if(p.startsWith('/api/projects/') && p.endsWith('/stage/rename') && req.method==='POST'){
    const s=getSession(req); if(!s) return json(res,401,{error:'auth'});
    if(!canEditProcess(s)) return json(res,403,{error:'Only the Supervisor or Managing Director can edit the process'});
    const id=p.split('/')[3];
    const proj=db.projects[id]; if(!proj) return json(res,404,{error:'not found'});
    const body=await readBody(req); let d={}; try{d=JSON.parse(body)}catch{}
    const stageId=(d.stageId||'').trim(); const name=(d.name||'').trim();
    if(!name) return json(res,400,{error:'Name is required'});
    const stageObj = (proj.stages||[]).find(x=>x.id===stageId); if(!stageObj) return json(res,404,{error:'stage not found'});
    const oldName = stageObj.name;
    stageObj.name = name;
    db.updates.unshift({ at:Date.now(), role:s.role, roleName:s.name, projectId:proj.id, projectName:proj.name, stage:proj.stage, text:`${s.name} renamed "${oldName}" to "${name}" on ${proj.name}` });
    db.updates = db.updates.slice(0,40);
    saveDB();
    return json(res,200,{ ok:true, project:proj, updates:db.updates.slice(0,15) });
  }
  if(p.startsWith('/api/projects/') && p.endsWith('/stage/field/add') && req.method==='POST'){
    const s=getSession(req); if(!s) return json(res,401,{error:'auth'});
    if(!canEditProcess(s)) return json(res,403,{error:'Only the Supervisor or Managing Director can edit the process'});
    const id=p.split('/')[3];
    const proj=db.projects[id]; if(!proj) return json(res,404,{error:'not found'});
    const body=await readBody(req); let d={}; try{d=JSON.parse(body)}catch{}
    const stageId=(d.stageId||'').trim(); const label=(d.label||'').trim(); const type=d.type==='file'?'file':'text';
    if(!label) return json(res,400,{error:'Field label is required'});
    const stageObj = (proj.stages||[]).find(x=>x.id===stageId); if(!stageObj) return json(res,404,{error:'stage not found'});
    stageObj.fields = stageObj.fields || [];
    stageObj.fields.push({ id:newFieldId(), label, type, value:'', origName:'' });
    db.updates.unshift({ at:Date.now(), role:s.role, roleName:s.name, projectId:proj.id, projectName:proj.name, stage:proj.stage, text:`${s.name} added a ${type==='file'?'document':'field'} "${label}" to "${stageObj.name}" on ${proj.name}` });
    db.updates = db.updates.slice(0,40);
    saveDB();
    return json(res,200,{ ok:true, project:proj, updates:db.updates.slice(0,15) });
  }
  if(p.startsWith('/api/projects/') && p.endsWith('/stage/field/remove') && req.method==='POST'){
    const s=getSession(req); if(!s) return json(res,401,{error:'auth'});
    if(!canEditProcess(s)) return json(res,403,{error:'Only the Supervisor or Managing Director can edit the process'});
    const id=p.split('/')[3];
    const proj=db.projects[id]; if(!proj) return json(res,404,{error:'not found'});
    const body=await readBody(req); let d={}; try{d=JSON.parse(body)}catch{}
    const stageId=(d.stageId||'').trim(); const fieldId=(d.fieldId||'').trim();
    const stageObj = (proj.stages||[]).find(x=>x.id===stageId); if(!stageObj) return json(res,404,{error:'stage not found'});
    stageObj.fields = (stageObj.fields||[]).filter(f=>f.id!==fieldId);
    saveDB();
    return json(res,200,{ ok:true, project:proj, updates:db.updates.slice(0,15) });
  }
  if(p.startsWith('/api/projects/') && p.endsWith('/stage/field/value') && req.method==='POST'){
    const s=getSession(req); if(!s) return json(res,401,{error:'auth'});
    const id=p.split('/')[3];
    const proj=db.projects[id]; if(!proj) return json(res,404,{error:'not found'});
    const body=await readBody(req); let d={}; try{d=JSON.parse(body)}catch{}
    const stageId=(d.stageId||'').trim(); const fieldId=(d.fieldId||'').trim(); const value=(d.value||'').toString();
    const stageObj = (proj.stages||[]).find(x=>x.id===stageId); if(!stageObj) return json(res,404,{error:'stage not found'});
    if(!canTouchStage(s, proj, stageObj)) return json(res,403,{error:'This stage is not assigned to you'});
    const field = (stageObj.fields||[]).find(f=>f.id===fieldId); if(!field) return json(res,404,{error:'field not found'});
    field.value = value;
    db.updates.unshift({ at:Date.now(), role:s.role, roleName:s.name, projectId:proj.id, projectName:proj.name, stage:proj.stage, text:`${s.name} filled "${field.label}" on ${proj.name}` });
    db.updates = db.updates.slice(0,40);
    saveDB();
    return json(res,200,{ ok:true, project:proj, updates:db.updates.slice(0,15) });
  }
  if(p.startsWith('/api/projects/') && p.endsWith('/stage/field/upload') && req.method==='POST'){
    const s=getSession(req); if(!s) return json(res,401,{error:'auth'});
    const id=p.split('/')[3];
    const proj=db.projects[id]; if(!proj) return json(res,404,{error:'not found'});
    const ct = req.headers['content-type']||'';
    const bm = ct.match(/boundary=(.+)$/);
    if(!bm) return json(res,400,{error:'expected multipart/form-data'});
    const buf = await readBodyBuffer(req);
    const parts = parseMultipart(buf, bm[1]);
    const field2 = name => { const pt=parts.find(x=>x.name===name); return pt ? pt.data.toString('utf8') : ''; };
    const stageId = field2('stageId'), fieldId = field2('fieldId');
    const filePart = parts.find(x=>x.name==='file' && x.filename);
    const stageObj = (proj.stages||[]).find(x=>x.id===stageId); if(!stageObj) return json(res,400,{error:'invalid stage'});
    if(!canTouchStage(s, proj, stageObj)) return json(res,403,{error:'This stage is not assigned to you'});
    const field = (stageObj.fields||[]).find(f=>f.id===fieldId); if(!field) return json(res,400,{error:'invalid field'});
    if(!filePart || !filePart.data.length) return json(res,400,{error:'No file provided'});
    if(filePart.data.length > MAX_UPLOAD_BYTES) return json(res,413,{error:'File is too large (max 15MB)'});
    const ext = path.extname(filePart.filename||'').toLowerCase();
    if(!ALLOWED_UPLOAD_EXT.includes(ext)) return json(res,400,{error:`File type "${ext||'unknown'}" is not allowed. Use PDF, Word, Excel, or an image.`});
    const safeName = `${id}-${stageId}-${fieldId}-${Date.now()}${ext}`;
    uploadStore.set(safeName, filePart.data); // in-memory only — see note on UPLOADS below
    field.value = safeName; field.origName = filePart.filename;
    db.updates.unshift({ at:Date.now(), role:s.role, roleName:s.name, projectId:proj.id, projectName:proj.name, stage:proj.stage, text:`${s.name} uploaded "${filePart.filename}" for "${field.label}" on ${proj.name}` });
    db.updates = db.updates.slice(0,40);
    saveDB();
    return json(res,200,{ ok:true, project:proj, updates:db.updates.slice(0,15) });
  }
  if(p.startsWith('/api/uploads/')){
    const s=getSession(req); if(!s) return json(res,401,{error:'auth'});
    const fname = decodeURIComponent(p.slice('/api/uploads/'.length));
    const data = uploadStore.get(fname);
    if(!data) return send(res,404,'Not found');
    return send(res,200,data,{'Content-Type':MIME[path.extname(fname)]||'application/octet-stream'});
  }
  if(p.startsWith('/api/projects/') && p.endsWith('/assign-module') && req.method==='POST'){
    const s=getSession(req); if(!s) return json(res,401,{error:'auth'});
    if(s.role!=='md') return json(res,403,{error:'Only the Managing Director can assign work areas'});
    const id=p.split('/')[3];
    const proj=db.projects[id]; if(!proj) return json(res,404,{error:'not found'});
    const body=await readBody(req); let d={}; try{d=JSON.parse(body)}catch{}
    const module=(d.module||'').trim(); const role=(d.role||'').trim();
    if(!MODULES.includes(module)) return json(res,400,{error:'invalid module'});
    if(role && !ROLE_NAME[role]) return json(res,400,{error:'invalid role'});
    proj.moduleAssignees = proj.moduleAssignees || {};
    proj.moduleAssignees[module] = role;
    const text = role
      ? `${s.name} assigned ${MODULE_LABEL[module]} on ${proj.name} to ${ROLE_NAME[role]}`
      : `${s.name} unassigned ${MODULE_LABEL[module]} on ${proj.name}`;
    db.updates.unshift({ at:Date.now(), role:s.role, roleName:s.name, projectId:proj.id, projectName:proj.name, stage:proj.stage, module, moduleRole:role, text });
    db.updates = db.updates.slice(0,40);
    saveDB();
    return json(res,200,{ ok:true, project:proj, updates:db.updates.slice(0,15) });
  }
  if(p.startsWith('/api/projects/') && p.endsWith('/module-item/add') && req.method==='POST'){
    const s=getSession(req); if(!s) return json(res,401,{error:'auth'});
    const id=p.split('/')[3];
    const proj=db.projects[id]; if(!proj) return json(res,404,{error:'not found'});
    const body=await readBody(req); let d={}; try{d=JSON.parse(body)}catch{}
    const module=(d.module||'').trim();
    if(!['materials','payments','documents'].includes(module)) return json(res,400,{error:'invalid module'});
    if(!canEditModule(s, proj, module)) return json(res,403,{error:'This work area is not assigned to you'});
    const name=(d.name||'').trim(); if(!name) return json(res,400,{error:'name is required'});
    const item = { name, status:'Pending' };
    if(module==='payments'){ item.amount = (d.amount||'').trim() || '—'; }
    if(module==='materials'){ item.qty=(d.qty||'').trim(); item.unit=(d.unit||'').trim(); item.note=(d.note||'').trim(); }
    if(module==='documents'){ item.docType=(d.docType||'').trim(); item.note=(d.note||'').trim(); }
    proj[module] = proj[module] || [];
    proj[module].push(item);
    db.updates.unshift({ at:Date.now(), role:s.role, roleName:s.name, projectId:proj.id, projectName:proj.name, stage:proj.stage, text:`${s.name} added to ${MODULE_LABEL[module]} on ${proj.name}: ${name}` });
    db.updates = db.updates.slice(0,40);
    saveDB();
    return json(res,200,{ ok:true, project:proj, updates:db.updates.slice(0,15) });
  }
  if(p.startsWith('/api/projects/') && p.endsWith('/module-item/toggle') && req.method==='POST'){
    const s=getSession(req); if(!s) return json(res,401,{error:'auth'});
    const id=p.split('/')[3];
    const proj=db.projects[id]; if(!proj) return json(res,404,{error:'not found'});
    const body=await readBody(req); let d={}; try{d=JSON.parse(body)}catch{}
    const module=(d.module||'').trim(); const idx=parseInt(d.idx,10);
    if(!['materials','payments','documents'].includes(module)) return json(res,400,{error:'invalid module'});
    if(!canEditModule(s, proj, module)) return json(res,403,{error:'This work area is not assigned to you'});
    const item = proj[module] && proj[module][idx]; if(!item) return json(res,404,{error:'item not found'});
    item.status = item.status==='Done' ? 'Pending' : 'Done';
    db.updates.unshift({ at:Date.now(), role:s.role, roleName:s.name, projectId:proj.id, projectName:proj.name, stage:proj.stage, text:`${s.name} marked "${item.name}" ${item.status} on ${proj.name}` });
    db.updates = db.updates.slice(0,40);
    saveDB();
    return json(res,200,{ ok:true, project:proj, updates:db.updates.slice(0,15) });
  }
  if(p.startsWith('/api/projects/') && p.endsWith('/po/create') && req.method==='POST'){
    const s=getSession(req); if(!s) return json(res,401,{error:'auth'});
    if(!canEditPO(s)) return json(res,403,{error:'Only the Supervisor or Managing Director can raise a purchase order'});
    const id=p.split('/')[3];
    const proj=db.projects[id]; if(!proj) return json(res,404,{error:'not found'});
    const body=await readBody(req); let d={}; try{d=JSON.parse(body)}catch{}
    const vendor = { name:(d.vendor&&d.vendor.name||'').trim(), address:(d.vendor&&d.vendor.address||'').trim(), phone:(d.vendor&&d.vendor.phone||'').trim(), email:(d.vendor&&d.vendor.email||'').trim() };
    const shipTo = { name:(d.shipTo&&d.shipTo.name||'').trim(), address:(d.shipTo&&d.shipTo.address||'').trim(), phone:(d.shipTo&&d.shipTo.phone||'').trim(), email:(d.shipTo&&d.shipTo.email||'').trim() };
    const items = Array.isArray(d.items) ? d.items
      .map(it=>({ name:(it.name||'').trim(), desc:(it.desc||'').trim(), qty:Number(it.qty)||0, unitPrice:Number(it.unitPrice)||0 }))
      .filter(it=>it.name) : [];
    if(!vendor.name) return json(res,400,{error:'Vendor name is required'});
    if(!items.length) return json(res,400,{error:'At least one item is required'});
    const po = {
      id: nextPoId(), vendor, shipTo, items,
      requestNo:(d.requestNo||'').trim(), shipVia:(d.shipVia||'').trim(), fob:(d.fob||'').trim(), shippingTerms:(d.shippingTerms||'').trim(),
      taxPercent:Number(d.taxPercent)||0, shippingFee:Number(d.shippingFee)||0,
      status:'Draft', raisedBy:s.name, date:new Date().toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric'})
    };
    proj.po = proj.po || [];
    proj.po.push(po);
    db.updates.unshift({ at:Date.now(), role:s.role, roleName:s.name, projectId:proj.id, projectName:proj.name, stage:proj.stage, text:`${s.name} raised ${po.id} on ${proj.name} — ${vendor.name}` });
    db.updates = db.updates.slice(0,40);
    saveDB();
    const emailResult = await sendPoEmail(proj, po);
    po.emailedTo = emailResult.sent ? vendor.email : null;
    if(emailResult.sent){
      db.updates.unshift({ at:Date.now(), role:s.role, roleName:s.name, projectId:proj.id, projectName:proj.name, stage:proj.stage, text:`${po.id} emailed to ${vendor.name} (${vendor.email})` });
      db.updates = db.updates.slice(0,40);
      saveDB();
    }
    return json(res,200,{ ok:true, project:proj, updates:db.updates.slice(0,15), email:emailResult });
  }
  if(p.match(/^\/api\/projects\/[^/]+\/po\/[^/]+\/pdf$/)){
    const s=getSession(req); if(!s) return json(res,401,{error:'auth'});
    const parts=p.split('/'); const id=parts[3]; const poId=parts[5];
    const proj=db.projects[id]; if(!proj) return send(res,404,'Project not found');
    const po=(proj.po||[]).find(x=>x.id===poId); if(!po) return send(res,404,'PO not found');
    let pdfBuf;
    try{ pdfBuf = poPdfBuffer(proj,po); }
    catch(e){ logError('poPdfBuffer', e); return json(res,500,{error:'Could not generate the PDF right now — please try again.'}); }
    return send(res,200,pdfBuf,{'Content-Type':'application/pdf','Content-Disposition':`attachment; filename="${po.id}.pdf"`});
  }
  if(p.startsWith('/api/projects/') && p.endsWith('/po/status') && req.method==='POST'){
    const s=getSession(req); if(!s) return json(res,401,{error:'auth'});
    if(!canEditPO(s)) return json(res,403,{error:'Only the Supervisor or Managing Director can update a purchase order'});
    const id=p.split('/')[3];
    const proj=db.projects[id]; if(!proj) return json(res,404,{error:'not found'});
    const body=await readBody(req); let d={}; try{d=JSON.parse(body)}catch{}
    const poId=(d.poId||'').trim();
    const po = (proj.po||[]).find(x=>x.id===poId); if(!po) return json(res,404,{error:'PO not found'});
    const curIdx = PO_STATUS.indexOf(po.status);
    if(curIdx < PO_STATUS.length-1) po.status = PO_STATUS[curIdx+1];
    db.updates.unshift({ at:Date.now(), role:s.role, roleName:s.name, projectId:proj.id, projectName:proj.name, stage:proj.stage, text:`${s.name} marked ${po.id} on ${proj.name} as ${po.status}` });
    db.updates = db.updates.slice(0,40);
    saveDB();
    return json(res,200,{ ok:true, project:proj, updates:db.updates.slice(0,15) });
  }
  if(p.startsWith('/api/projects/') && p.endsWith('/notify') && req.method==='POST'){
    const s=getSession(req); if(!s) return json(res,401,{error:'auth'});
    const id=p.split('/')[3];
    const proj=db.projects[id]; if(!proj) return json(res,404,{error:'not found'});
    const body=await readBody(req); let d={}; try{d=JSON.parse(body)}catch{}
    const curStage = (proj.stages||[])[proj.stage-1];
    const message=(d.message||'').trim() || `Update on ${curStage?curStage.name:'current stage'}`;
    db.updates.unshift({ at:Date.now(), role:s.role, roleName:s.name, projectId:proj.id, projectName:proj.name, stage:proj.stage, notify:true, text:`${s.name} notified the MD — ${proj.name}: ${message}` });
    db.updates = db.updates.slice(0,40);
    saveDB();
    return json(res,200,{ ok:true, updates:db.updates.slice(0,15) });
  }
  if(p==='/api/reset' && req.method==='POST'){
    const s=getSession(req); if(!s) return json(res,401,{error:'auth'});
    seedProjects(); db.updates=[]; saveDB();
    return json(res,200,{ok:true});
  }

  // ---- Pages ----
  if(p==='/login') return serveFile(res, path.join(PUB,'login.html'));
  if(p==='/' || p==='/app' || p==='/team'){
    const s=getSession(req);
    if(!s){ res.writeHead(302,{Location:'/login'}); return res.end(); }
    const file = s.role==='md' ? 'app.html' : 'team.html';
    return serveFile(res, path.join(PUB, file));
  }

  // ---- Static ----
  const fp = path.join(PUB, p);
  if(fp.startsWith(PUB) && fs.existsSync(fp) && fs.statSync(fp).isFile()) return serveFile(res, fp);
  res.writeHead(302,{Location:'/'}); res.end();
}

// Every request goes through this wrapper — an error anywhere in handleRequest (bad input, a bug,
// a body-too-large rejection) is caught here and turned into a clean HTTP response instead of
// crashing the whole server. This is the single most important guard: without it, one unexpected
// error in any request handler takes down every user's session, not just the one bad request.
const server = http.createServer((req,res)=>{
  handleRequest(req,res).catch(err=>{
    logError(`request ${req.method} ${req.url}`, err);
    if(res.headersSent) return;
    const tooLarge = /too large/i.test(err && err.message || '');
    try{ json(res, tooLarge?413:500, {error: tooLarge ? 'Request too large' : 'Something went wrong on our end — please try again.'}); }
    catch{ /* if even the error response fails, give up quietly rather than throw again */ }
  });
});

// On Vercel this file is loaded as a serverless function (see vercel.json) — it must export a
// (req,res) handler and must NOT call .listen(), since Vercel's runtime owns the actual HTTP
// server. Locally (or on Railway/Render/etc), VERCEL is unset, so a normal persistent server starts.
// IMPORTANT caveat for Vercel specifically: the in-memory `db` above is per-instance — serverless
// platforms can route different requests to different warm instances, so data created by one
// request may not be visible to another. Fine for exercising a single flow in one sitting; for a
// real multi-person live demo, a persistent host (Railway/Render) or a real database is required.
if(!process.env.VERCEL){
  server.listen(PORT, ()=>{
    console.log(`\n  Sunworld Command Center (MVP) → http://localhost:${PORT}`);
    console.log(`  No password needed — sign in with just a username:`);
    console.log(`  MD login: admin`);
    console.log(`  Site Manager login: sitemanager (sees only tasks assigned to "Site Manager")`);
    console.log(`  Supervisor login: supervisor (builds Stages 1-10 for any project; Site Execution still needs MD assignment)`);
    console.log(`  Coordinator login: coordinator (covers every stage except Site Execution, across all 5 services)\n`);
  });
}

module.exports = (req, res) => {
  handleRequest(req,res).catch(err=>{
    logError(`request ${req.method} ${req.url}`, err);
    if(res.headersSent) return;
    const tooLarge = /too large/i.test(err && err.message || '');
    try{ json(res, tooLarge?413:500, {error: tooLarge ? 'Request too large' : 'Something went wrong on our end — please try again.'}); }
    catch{}
  });
};
