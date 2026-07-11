// Sunworld Command Center — MVP server (zero dependencies, Node core only)
// Roles: MD (read-only overview) + team roles that update their stage of a Warehouse project.
// Every team update flows into the shared warehouse state, which the MD dashboard reads live.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;
const PUB = path.join(ROOT, 'public');
const DB = path.join(ROOT, 'db.json');
const PORT = process.env.PORT || 4173;

// ---- Users / roles (demo credentials) ----
// stages = which lifecycle stages this role is allowed to complete.
const USERS = {
  admin:      { pass:'admin123',      role:'md',        name:'Managing Director',       stages:[] },
  sales:      { pass:'sales123',      role:'sales',     name:'Sales & Survey',          stages:[1] },
  commercial: { pass:'commercial123', role:'commercial',name:'Commercial / Estimation', stages:[2,3] },
  design:     { pass:'design123',     role:'design',    name:'Design Team',             stages:[4] },
  purchase:   { pass:'purchase123',   role:'purchase',  name:'Purchase / Stores',       stages:[5] },
  site:       { pass:'site123',       role:'site',      name:'Site Engineer',           stages:[6] },
  qc:         { pass:'qc123',         role:'qc',        name:'Quality Control',         stages:[7] },
  accounts:   { pass:'accounts123',   role:'accounts',  name:'Accounts',                stages:[8,9] },
  pm:         { pass:'pm123',         role:'pm',        name:'Project Coordinator',     stages:[10] },
};

const STAGE_NAME = ['Enquiry & Survey','Quotation','Work Order','Drawings','Procurement','Site Execution','Quality / QC','Client Update','Invoicing','Handover'];
const STEEL_SUB  = ['Foundation','Column & Beam Erection','Roof Purlin & Sheeting','Wall Cladding','MEP Rough-in','Flooring','Finishing & Handover'];

// ---- Warehouse module seed (10 projects, spread across stages so every role has work) ----
const WH_SEED = [
  {id:'SW-2026-041', name:'Sunrise Cold Chain',          site:'Perundurai, TN',   tag:'Cold-storage warehouse',  val:'₹2.20 Cr', team:'Unassigned',         start:'02 Jul 2026', delivery:'—',           stage:1,  sub:0, status:'ok',   note:''},
  {id:'SW-2026-034', name:'Rasi Seeds Storage Warehouse',site:'Attur, TN',        tag:'Seed-storage warehouse',  val:'₹1.45 Cr', team:'Unassigned',         start:'30 Jun 2026', delivery:'22 Dec 2026', stage:2,  sub:0, status:'ok',   note:''},
  {id:'SW-2026-038', name:'KMP Distribution Hub',        site:'Krishnagiri, TN',  tag:'Distribution warehouse',  val:'₹1.95 Cr', team:'Team B — Karthik R.',start:'20 Jun 2026', delivery:'15 Jan 2027', stage:3,  sub:0, status:'ok',   note:''},
  {id:'SW-2026-039', name:'Deccan Grain Silo Warehouse', site:'Dindigul, TN',     tag:'Grain-storage warehouse', val:'₹2.60 Cr', team:'Team B — Karthik R.',start:'15 May 2026', delivery:'28 Dec 2026', stage:4,  sub:0, status:'warn', note:'GA drawing R1 awaiting client approval.'},
  {id:'SW-2026-040', name:'AGT Foods Warehouse',         site:'Erode, TN',        tag:'Food-grade warehouse',    val:'₹1.70 Cr', team:'Team C — Manoj V.',  start:'28 Apr 2026', delivery:'10 Oct 2026', stage:5,  sub:0, status:'warn', note:'Awaiting roof-sheeting delivery.'},
  {id:'SW-2026-014', name:'Vellore Logistics Park',      site:'Ranipet, TN',      tag:'Warehouse · 42,000 sq ft',val:'₹1.85 Cr', team:'Team B — Karthik R.',start:'04 Apr 2026', delivery:'12 Aug 2026', stage:6,  sub:2, status:'warn', note:'Drawing R2 approved, but site is building to R1 — resolve before wall cladding.'},
  {id:'SW-2026-005', name:'Sri Balaji Warehousing',      site:'Hosur, TN',        tag:'Warehouse · 60,000 sq ft',val:'₹3.10 Cr', team:'Team A — Suresh M.', start:'02 Feb 2026', delivery:'30 Jun 2026', stage:6,  sub:5, status:'late', note:'4 days behind on Flooring sub-stage.'},
  {id:'SW-2026-042', name:'Nilgiri Dairy Cold Store',    site:'Ooty, TN',         tag:'Dairy cold store',        val:'₹2.05 Cr', team:'Team A — Suresh M.', start:'10 Mar 2026', delivery:'05 Sep 2026', stage:7,  sub:0, status:'ok',   note:''},
  {id:'SW-2026-002', name:'Metro Fresh Distribution',    site:'Chennai, TN',      tag:'Cold-storage warehouse',  val:'₹2.75 Cr', team:'Team A — Suresh M.', start:'12 Jan 2026', delivery:'20 Jun 2026', stage:9,  sub:0, status:'ok',   note:''},
  {id:'SW-2026-001', name:'Aditya Pharma Godown',        site:'Sriperumbudur, TN',tag:'Pharma warehouse',        val:'₹2.10 Cr', team:'Team A — Suresh M.', start:'05 Jan 2026', delivery:'—',           stage:10, sub:0, status:'ok',   note:''},
];

function pctOf(p){
  const frac = ((p.stage-1) + (p.stage===6 ? p.sub/STEEL_SUB.length : 0)) / 9;
  return Math.max(0, Math.min(100, Math.round(frac*100)));
}

// ---- Persistence ----
function loadDB(){ try { return JSON.parse(fs.readFileSync(DB,'utf8')); } catch { return {}; } }
function saveDB(){ fs.writeFileSync(DB, JSON.stringify(db,null,2)); }
let db = loadDB();
function seedWarehouse(){ db.warehouse = {}; WH_SEED.forEach(p=>{ db.warehouse[p.id] = Object.assign({}, p, {pct:pctOf(p)}); }); }
if(!db.warehouse){ seedWarehouse(); }
if(!db.updates){ db.updates = []; }
saveDB();

function whArray(){ return WH_SEED.map(s=>db.warehouse[s.id]); }

function doAdvance(p, sess){
  let text;
  if(p.stage===6){
    if(p.sub < STEEL_SUB.length-1){
      p.sub++;
      text = `advanced ${p.name} to “${STEEL_SUB[p.sub]}”`;
    } else {
      p.stage = 7; p.sub = 0;
      text = `completed Site Execution on ${p.name} → moved to Quality / QC`;
    }
  } else {
    const from = STAGE_NAME[p.stage-1];
    if(p.stage < 10){ p.stage++; text = `completed ${from} on ${p.name} → moved to ${STAGE_NAME[p.stage-1]}`; }
    else { text = `completed Handover on ${p.name}`; }
  }
  if(p.note) p.note = '';
  if(p.status !== 'ok') p.status = 'ok';
  p.pct = pctOf(p);
  db.updates.unshift({ at:Date.now(), role:sess.role, roleName:sess.name, projectId:p.id, projectName:p.name, stage:p.stage, text:`${sess.name} ${text}` });
  db.updates = db.updates.slice(0,40);
  return text;
}

// ---- Sessions ----
const sessions = new Map(); // sid -> {user, role, name, stages}

function parseCookies(req){
  const h = req.headers.cookie || '';
  return Object.fromEntries(h.split(';').map(v=>v.trim().split('=').map(decodeURIComponent)).filter(a=>a[0]));
}
function getSession(req){ const c=parseCookies(req); return c.sw_sid ? sessions.get(c.sw_sid) : null; }
function send(res, code, body, headers={}){ res.writeHead(code, headers); res.end(body); }
function json(res, code, obj, headers={}){ send(res, code, JSON.stringify(obj), Object.assign({'Content-Type':'application/json'}, headers)); }
function readBody(req){ return new Promise(r=>{ let d=''; req.on('data',c=>d+=c); req.on('end',()=>r(d)); }); }

const MIME = { '.html':'text/html','.css':'text/css','.js':'text/javascript','.json':'application/json','.svg':'image/svg+xml','.ico':'image/x-icon','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp' };
function serveFile(res, fp){ fs.readFile(fp,(e,data)=>{ if(e) return send(res,404,'Not found'); send(res,200,data,{'Content-Type':MIME[path.extname(fp)]||'text/plain'}); }); }

const server = http.createServer(async (req,res)=>{
  const u = new URL(req.url,'http://localhost');
  const p = u.pathname;

  // ---- API ----
  if(p==='/api/login' && req.method==='POST'){
    const body=await readBody(req); let d={}; try{d=JSON.parse(body)}catch{}
    const key=(d.user||'').toLowerCase().trim();
    const U=USERS[key];
    if(U && U.pass===d.pass){
      const sid=crypto.randomBytes(16).toString('hex');
      sessions.set(sid, {user:key, role:U.role, name:U.name, stages:U.stages});
      return json(res,200,{ok:true, role:U.role, name:U.name}, {'Set-Cookie':`sw_sid=${sid}; Path=/; HttpOnly; Max-Age=86400; SameSite=Lax`});
    }
    return json(res,401,{ok:false, error:'Invalid username or password'});
  }
  if(p==='/api/logout' && req.method==='POST'){
    const c=parseCookies(req); sessions.delete(c.sw_sid);
    return json(res,200,{ok:true},{'Set-Cookie':'sw_sid=; Path=/; Max-Age=0'});
  }
  if(p==='/api/me'){
    const s=getSession(req); if(!s) return json(res,401,{error:'auth'});
    return json(res,200,{user:s.user, role:s.role, name:s.name, stages:s.stages});
  }
  if(p==='/api/warehouse'){
    const s=getSession(req); if(!s) return json(res,401,{error:'auth'});
    return json(res,200,{ projects:whArray(), updates:db.updates.slice(0,15) });
  }
  if(p.startsWith('/api/warehouse/') && p.endsWith('/advance') && req.method==='POST'){
    const s=getSession(req); if(!s) return json(res,401,{error:'auth'});
    const id=p.split('/')[3];
    const proj=db.warehouse[id]; if(!proj) return json(res,404,{error:'not found'});
    if(!(s.stages||[]).includes(proj.stage)) return json(res,403,{error:'Your role cannot update this stage'});
    doAdvance(proj, s); saveDB();
    return json(res,200,{ ok:true, project:proj, updates:db.updates.slice(0,15) });
  }
  if(p==='/api/reset' && req.method==='POST'){
    const s=getSession(req); if(!s) return json(res,401,{error:'auth'});
    seedWarehouse(); db.updates=[]; saveDB();
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
});

server.listen(PORT, ()=>{
  console.log(`\n  Sunworld Command Center (MVP) → http://localhost:${PORT}`);
  console.log(`  MD login: admin / admin123`);
  console.log(`  Team logins: sales, commercial, design, purchase, site, qc, accounts, pm  (password = <name>123)\n`);
});
