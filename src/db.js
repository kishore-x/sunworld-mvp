// src/db.js
require('dotenv').config();
const { DatabaseSync } = require('node:sqlite');
const { createClient } = require('@supabase/supabase-js');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, '..', 'sunworld.db');

// Detect Supabase config
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;

let supabase = null;
if (supabaseUrl && supabaseUrl !== 'YOUR_SUPABASE_PROJECT_URL' && supabaseKey) {
  console.log('[db] SUPABASE_URL configuration detected. Using Supabase database provider.');
  supabase = createClient(supabaseUrl, supabaseKey, {
    auth: { persistSession: false }
  });
} else {
  console.log('[db] No SUPABASE_URL configuration found. Falling back to local SQLite provider.');
}

// ------------------------------------------------------------
// Local SQLite Initialization (runs only if SQLite fallback is active)
// ------------------------------------------------------------
let sqliteDb = null;
if (!supabase) {
  sqliteDb = new DatabaseSync(DB_PATH);
}

function initDb() {
  if (supabase) {
    console.log('[db] Initialization: Supabase uses cloud schema (managed in Supabase SQL editor).');
    return;
  }

  // Create tables in SQLite
  sqliteDb.exec(`
    CREATE TABLE IF NOT EXISTS users (
      user TEXT PRIMARY KEY,
      passHash TEXT NOT NULL,
      role TEXT NOT NULL,
      name TEXT NOT NULL,
      canGeneral INTEGER NOT NULL,
      canSiteExecution INTEGER NOT NULL,
      person TEXT
    );

    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      service TEXT NOT NULL,
      name TEXT NOT NULL,
      site TEXT NOT NULL,
      tag TEXT,
      val TEXT,
      team TEXT,
      start TEXT,
      delivery TEXT,
      stage INTEGER NOT NULL DEFAULT 1,
      sub INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'ok',
      note TEXT,
      pct INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS project_stages (
      project_id TEXT NOT NULL,
      id TEXT NOT NULL,
      name TEXT NOT NULL,
      desc TEXT,
      kind TEXT,
      seq INTEGER NOT NULL,
      PRIMARY KEY (project_id, id),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS stage_fields (
      project_id TEXT NOT NULL,
      stage_id TEXT NOT NULL,
      id TEXT NOT NULL,
      label TEXT NOT NULL,
      type TEXT NOT NULL,
      value TEXT,
      origName TEXT,
      PRIMARY KEY (project_id, stage_id, id),
      FOREIGN KEY (project_id, stage_id) REFERENCES project_stages(project_id, id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS project_assignees (
      project_id TEXT NOT NULL,
      stage_id TEXT NOT NULL,
      person TEXT NOT NULL,
      PRIMARY KEY (project_id, stage_id),
      FOREIGN KEY (project_id, stage_id) REFERENCES project_stages(project_id, id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS project_module_assignees (
      project_id TEXT NOT NULL,
      module TEXT NOT NULL,
      role TEXT NOT NULL,
      PRIMARY KEY (project_id, module),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS module_items (
      project_id TEXT NOT NULL,
      module TEXT NOT NULL,
      idx INTEGER NOT NULL,
      name TEXT NOT NULL,
      status TEXT NOT NULL,
      amount TEXT,
      qty TEXT,
      unit TEXT,
      note TEXT,
      docType TEXT,
      PRIMARY KEY (project_id, module, idx),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS purchase_orders (
      project_id TEXT NOT NULL,
      id TEXT PRIMARY KEY,
      requestNo TEXT,
      shipVia TEXT,
      fob TEXT,
      shippingTerms TEXT,
      taxPercent REAL NOT NULL DEFAULT 0,
      shippingFee REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'Draft',
      raisedBy TEXT,
      date TEXT,
      emailedTo TEXT,
      vendorName TEXT,
      vendorAddress TEXT,
      vendorPhone TEXT,
      vendorEmail TEXT,
      shipToName TEXT,
      shipToAddress TEXT,
      shipToPhone TEXT,
      shipToEmail TEXT,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS po_items (
      po_id TEXT NOT NULL,
      idx INTEGER NOT NULL,
      name TEXT NOT NULL,
      desc TEXT,
      qty REAL NOT NULL,
      unitPrice REAL NOT NULL,
      PRIMARY KEY (po_id, idx),
      FOREIGN KEY (po_id) REFERENCES purchase_orders(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS updates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at INTEGER NOT NULL,
      role TEXT,
      roleName TEXT,
      projectId TEXT,
      projectName TEXT,
      stage INTEGER,
      notify INTEGER DEFAULT 0,
      module TEXT,
      moduleRole TEXT,
      text TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      sid TEXT PRIMARY KEY,
      user TEXT NOT NULL,
      role TEXT NOT NULL,
      name TEXT NOT NULL,
      canGeneral INTEGER NOT NULL,
      canSiteExecution INTEGER NOT NULL,
      person TEXT,
      csrf TEXT NOT NULL,
      createdAt INTEGER NOT NULL
    );
  `);
}

// Transaction helper for SQLite
function runSqliteTransaction(fn) {
  sqliteDb.exec('BEGIN TRANSACTION');
  try {
    const res = fn();
    sqliteDb.exec('COMMIT');
    return res;
  } catch (err) {
    sqliteDb.exec('ROLLBACK');
    throw err;
  }
}

// ------------------------------------------------------------
// Database Operations (Unified Async Interfaces)
// ------------------------------------------------------------

async function insertUser(user, passHash, role, name, canGeneral, canSiteExecution, person) {
  if (supabase) {
    const { error } = await supabase.from('users').upsert({
      user,
      passHash,
      role,
      name,
      canGeneral: !!canGeneral,
      canSiteExecution: !!canSiteExecution,
      person: person || null
    });
    if (error) throw error;
  } else {
    const stmt = sqliteDb.prepare(`
      INSERT OR REPLACE INTO users (user, passHash, role, name, canGeneral, canSiteExecution, person)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(user, passHash, role, name, canGeneral ? 1 : 0, canSiteExecution ? 1 : 0, person || null);
  }
}

async function getUser(username) {
  if (supabase) {
    const { data, error } = await supabase
      .from('users')
      .select('*')
      .eq('user', username)
      .maybeSingle();
    if (error) throw error;
    if (!data) return null;
    return {
      ...data,
      canGeneral: !!data.canGeneral,
      canSiteExecution: !!data.canSiteExecution
    };
  } else {
    const stmt = sqliteDb.prepare('SELECT * FROM users WHERE user = ?');
    const u = stmt.get(username);
    if (!u) return null;
    return {
      ...u,
      canGeneral: u.canGeneral === 1,
      canSiteExecution: u.canSiteExecution === 1
    };
  }
}

async function saveSession(sid, sess) {
  if (supabase) {
    const { error } = await supabase.from('sessions').upsert({
      sid,
      user: sess.user,
      role: sess.role,
      name: sess.name,
      canGeneral: !!sess.canGeneral,
      canSiteExecution: !!sess.canSiteExecution,
      person: sess.person || null,
      csrf: sess.csrf,
      createdAt: sess.createdAt
    });
    if (error) throw error;
  } else {
    const stmt = sqliteDb.prepare(`
      INSERT OR REPLACE INTO sessions (sid, user, role, name, canGeneral, canSiteExecution, person, csrf, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      sid,
      sess.user,
      sess.role,
      sess.name,
      sess.canGeneral ? 1 : 0,
      sess.canSiteExecution ? 1 : 0,
      sess.person || null,
      sess.csrf,
      sess.createdAt
    );
  }
}

async function getSession(sid) {
  if (supabase) {
    const { data, error } = await supabase
      .from('sessions')
      .select('*')
      .eq('sid', sid)
      .maybeSingle();
    if (error) throw error;
    if (!data) return null;
    return {
      ...data,
      canGeneral: !!data.canGeneral,
      canSiteExecution: !!data.canSiteExecution
    };
  } else {
    const stmt = sqliteDb.prepare('SELECT * FROM sessions WHERE sid = ?');
    const s = stmt.get(sid);
    if (!s) return null;
    return {
      ...s,
      canGeneral: s.canGeneral === 1,
      canSiteExecution: s.canSiteExecution === 1
    };
  }
}

async function deleteSession(sid) {
  if (supabase) {
    const { error } = await supabase.from('sessions').delete().eq('sid', sid);
    if (error) throw error;
  } else {
    const stmt = sqliteDb.prepare('DELETE FROM sessions WHERE sid = ?');
    stmt.run(sid);
  }
}

async function cleanExpiredSessions(maxAgeMs) {
  const cutoff = Date.now() - maxAgeMs;
  if (supabase) {
    const { error } = await supabase.from('sessions').delete().lt('createdAt', cutoff);
    if (error) throw error;
  } else {
    const stmt = sqliteDb.prepare('DELETE FROM sessions WHERE createdAt < ?');
    stmt.run(cutoff);
  }
}

async function getAllSessions() {
  if (supabase) {
    const { data, error } = await supabase.from('sessions').select('*');
    if (error) throw error;
    const sessionsMap = {};
    (data || []).forEach(r => {
      sessionsMap[r.sid] = {
        user: r.user,
        role: r.role,
        name: r.name,
        canGeneral: !!r.canGeneral,
        canSiteExecution: !!r.canSiteExecution,
        person: r.person,
        csrf: r.csrf,
        createdAt: Number(r.createdAt)
      };
    });
    return sessionsMap;
  } else {
    const stmt = sqliteDb.prepare('SELECT * FROM sessions');
    const rows = stmt.all();
    const sessionsMap = {};
    rows.forEach(r => {
      sessionsMap[r.sid] = {
        user: r.user,
        role: r.role,
        name: r.name,
        canGeneral: r.canGeneral === 1,
        canSiteExecution: r.canSiteExecution === 1,
        person: r.person,
        csrf: r.csrf,
        createdAt: r.createdAt
      };
    });
    return sessionsMap;
  }
}

async function createProject(proj) {
  if (supabase) {
    // 1. Insert base project
    const { error: pErr } = await supabase.from('projects').insert({
      id: proj.id,
      service: proj.service,
      name: proj.name,
      site: proj.site,
      tag: proj.tag || '',
      val: proj.val || '₹0.0 L',
      team: proj.team || 'Unassigned',
      start: proj.start || '',
      delivery: proj.delivery || '—',
      stage: proj.stage || 1,
      sub: proj.sub || 0,
      status: proj.status || 'ok',
      note: proj.note || '',
      pct: proj.pct || 0
    });
    if (pErr) throw pErr;

    // 2. Insert stages & fields
    const stagesToInsert = [];
    const fieldsToInsert = [];
    (proj.stages || []).forEach((st, idx) => {
      stagesToInsert.push({
        project_id: proj.id,
        id: st.id,
        name: st.name,
        desc: st.desc || '',
        kind: st.kind || null,
        seq: idx
      });
      (st.fields || []).forEach(f => {
        fieldsToInsert.push({
          project_id: proj.id,
          stage_id: st.id,
          id: f.id,
          label: f.label,
          type: f.type,
          value: f.value || '',
          origName: f.origName || ''
        });
      });
    });

    if (stagesToInsert.length > 0) {
      const { error: stErr } = await supabase.from('project_stages').insert(stagesToInsert);
      if (stErr) throw stErr;
    }
    if (fieldsToInsert.length > 0) {
      const { error: fldErr } = await supabase.from('stage_fields').insert(fieldsToInsert);
      if (fldErr) throw fldErr;
    }

    // 3. Insert assignees
    const assignToInsert = [];
    Object.entries(proj.assignees || {}).forEach(([stageId, person]) => {
      if (person) {
        assignToInsert.push({
          project_id: proj.id,
          stage_id: stageId,
          person
        });
      }
    });
    if (assignToInsert.length > 0) {
      const { error: assErr } = await supabase.from('project_assignees').insert(assignToInsert);
      if (assErr) throw assErr;
    }

    // 4. Insert module assignees
    const modAssignToInsert = [];
    Object.entries(proj.moduleAssignees || {}).forEach(([module, role]) => {
      if (role) {
        modAssignToInsert.push({
          project_id: proj.id,
          module,
          role
        });
      }
    });
    if (modAssignToInsert.length > 0) {
      const { error: maErr } = await supabase.from('project_module_assignees').insert(modAssignToInsert);
      if (maErr) throw maErr;
    }

    // 5. Insert module items
    const itemsToInsert = [];
    ['materials', 'payments', 'documents'].forEach(mod => {
      (proj[mod] || []).forEach((item, idx) => {
        itemsToInsert.push({
          project_id: proj.id,
          module: mod,
          idx,
          name: item.name,
          status: item.status || 'Pending',
          amount: item.amount || null,
          qty: item.qty || null,
          unit: item.unit || null,
          note: item.note || null,
          docType: item.docType || null
        });
      });
    });
    if (itemsToInsert.length > 0) {
      const { error: itemErr } = await supabase.from('module_items').insert(itemsToInsert);
      if (itemErr) throw itemErr;
    }
  } else {
    runSqliteTransaction(() => {
      // 1. Insert base project
      const pStmt = sqliteDb.prepare(`
        INSERT INTO projects (id, service, name, site, tag, val, team, start, delivery, stage, sub, status, note, pct)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      pStmt.run(
        proj.id,
        proj.service,
        proj.name,
        proj.site,
        proj.tag || '',
        proj.val || '₹0.0 L',
        proj.team || 'Unassigned',
        proj.start || '',
        proj.delivery || '—',
        proj.stage || 1,
        proj.sub || 0,
        proj.status || 'ok',
        proj.note || '',
        proj.pct || 0
      );

      // 2. Insert stages
      const stageStmt = sqliteDb.prepare(`
        INSERT INTO project_stages (project_id, id, name, desc, kind, seq)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      const fieldStmt = sqliteDb.prepare(`
        INSERT INTO stage_fields (project_id, stage_id, id, label, type, value, origName)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);

      (proj.stages || []).forEach((st, idx) => {
        stageStmt.run(proj.id, st.id, st.name, st.desc || '', st.kind || null, idx);
        (st.fields || []).forEach(f => {
          fieldStmt.run(proj.id, st.id, f.id, f.label, f.type, f.value || '', f.origName || '');
        });
      });

      // 3. Insert assignees
      const assignStmt = sqliteDb.prepare(`
        INSERT INTO project_assignees (project_id, stage_id, person)
        VALUES (?, ?, ?)
      `);
      Object.entries(proj.assignees || {}).forEach(([stageId, person]) => {
        if (person) assignStmt.run(proj.id, stageId, person);
      });

      // 4. Insert module assignees
      const modAssignStmt = sqliteDb.prepare(`
        INSERT INTO project_module_assignees (project_id, module, role)
        VALUES (?, ?, ?)
      `);
      Object.entries(proj.moduleAssignees || {}).forEach(([module, role]) => {
        if (role) modAssignStmt.run(proj.id, module, role);
      });

      // 5. Insert module items
      const itemStmt = sqliteDb.prepare(`
        INSERT INTO module_items (project_id, module, idx, name, status, amount, qty, unit, note, docType)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      ['materials', 'payments', 'documents'].forEach(mod => {
        (proj[mod] || []).forEach((item, idx) => {
          itemStmt.run(
            proj.id,
            mod,
            idx,
            item.name,
            item.status || 'Pending',
            item.amount || null,
            item.qty || null,
            item.unit || null,
            item.note || null,
            item.docType || null
          );
        });
      });
    });
  }
}

async function getProject(id) {
  if (supabase) {
    const [
      projRes,
      stagesRes,
      fieldsRes,
      assigneesRes,
      modAssigneesRes,
      itemsRes,
      poRes
    ] = await Promise.all([
      supabase.from('projects').select('*').eq('id', id).maybeSingle(),
      supabase.from('project_stages').select('*').eq('project_id', id).order('seq', { ascending: true }),
      supabase.from('stage_fields').select('*').eq('project_id', id),
      supabase.from('project_assignees').select('*').eq('project_id', id),
      supabase.from('project_module_assignees').select('*').eq('project_id', id),
      supabase.from('module_items').select('*').eq('project_id', id).order('idx', { ascending: true }),
      supabase.from('purchase_orders').select('*').eq('project_id', id)
    ]);

    if (projRes.error) throw projRes.error;
    const proj = projRes.data;
    if (!proj) return null;

    const stages = stagesRes.data || [];
    const allFields = fieldsRes.data || [];
    stages.forEach(st => {
      st.fields = allFields
        .filter(f => f.stage_id === st.id)
        .map(f => ({
          id: f.id,
          label: f.label,
          type: f.type,
          value: f.value || '',
          origName: f.origName || ''
        }));
      if (st.kind === null) delete st.kind;
    });

    const assignees = {};
    (assigneesRes.data || []).forEach(a => {
      assignees[a.stage_id] = a.person;
    });

    const moduleAssignees = { progress: '', materials: '', payments: '', documents: '' };
    (modAssigneesRes.data || []).forEach(ma => {
      moduleAssignees[ma.module] = ma.role;
    });

    const allItems = itemsRes.data || [];
    const materials = allItems.filter(i => i.module === 'materials').map(i => ({ name: i.name, status: i.status, qty: i.qty || '', unit: i.unit || '', note: i.note || '' }));
    const payments = allItems.filter(i => i.module === 'payments').map(i => ({ name: i.name, status: i.status, amount: i.amount || '' }));
    const documents = allItems.filter(i => i.module === 'documents').map(i => ({ name: i.name, status: i.status, docType: i.docType || '', note: i.note || '' }));

    const pos = poRes.data || [];
    if (pos.length > 0) {
      const poIds = pos.map(po => po.id);
      const { data: poItems, error: poItemsErr } = await supabase
        .from('po_items')
        .select('*')
        .in('po_id', poIds)
        .order('idx', { ascending: true });
      if (poItemsErr) throw poItemsErr;

      pos.forEach(po => {
        po.vendor = {
          name: po.vendorName || '',
          address: po.vendorAddress || '',
          phone: po.vendorPhone || '',
          email: po.vendorEmail || ''
        };
        po.shipTo = {
          name: po.shipToName || '',
          address: po.shipToAddress || '',
          phone: po.shipToPhone || '',
          email: po.shipToEmail || ''
        };
        
        delete po.vendorName; delete po.vendorAddress; delete po.vendorPhone; delete po.vendorEmail;
        delete po.shipToName; delete po.shipToAddress; delete po.shipToPhone; delete po.shipToEmail;

        po.items = (poItems || [])
          .filter(it => it.po_id === po.id)
          .map(it => ({
            name: it.name,
            desc: it.desc || '',
            qty: Number(it.qty),
            unitPrice: Number(it.unitPrice)
          }));
      });
    }

    return {
      id: proj.id,
      service: proj.service,
      name: proj.name,
      site: proj.site,
      tag: proj.tag || '',
      val: proj.val || '',
      team: proj.team || 'Unassigned',
      start: proj.start || '',
      delivery: proj.delivery || '—',
      stage: proj.stage,
      sub: proj.sub,
      status: proj.status,
      note: proj.note || '',
      pct: proj.pct,
      stages,
      assignees,
      moduleAssignees,
      materials,
      payments,
      documents,
      po: pos
    };
  } else {
    const pStmt = sqliteDb.prepare('SELECT * FROM projects WHERE id = ?');
    const proj = pStmt.get(id);
    if (!proj) return null;

    const stagesStmt = sqliteDb.prepare('SELECT * FROM project_stages WHERE project_id = ? ORDER BY seq ASC');
    const stages = stagesStmt.all(id);

    const fieldsStmt = sqliteDb.prepare('SELECT * FROM stage_fields WHERE project_id = ?');
    const allFields = fieldsStmt.all(id);

    stages.forEach(st => {
      st.fields = allFields
        .filter(f => f.stage_id === st.id)
        .map(f => ({
          id: f.id,
          label: f.label,
          type: f.type,
          value: f.value || '',
          origName: f.origName || ''
        }));
      if (st.kind === null) delete st.kind;
    });

    const assignStmt = sqliteDb.prepare('SELECT * FROM project_assignees WHERE project_id = ?');
    const assignees = {};
    assignStmt.all(id).forEach(a => {
      assignees[a.stage_id] = a.person;
    });

    const modAssignStmt = sqliteDb.prepare('SELECT * FROM project_module_assignees WHERE project_id = ?');
    const moduleAssignees = { progress: '', materials: '', payments: '', documents: '' };
    modAssignStmt.all(id).forEach(ma => {
      moduleAssignees[ma.module] = ma.role;
    });

    const itemsStmt = sqliteDb.prepare('SELECT * FROM module_items WHERE project_id = ? ORDER BY idx ASC');
    const allItems = itemsStmt.all(id);

    const materials = allItems.filter(i => i.module === 'materials').map(i => ({ name: i.name, status: i.status, qty: i.qty || '', unit: i.unit || '', note: i.note || '' }));
    const payments = allItems.filter(i => i.module === 'payments').map(i => ({ name: i.name, status: i.status, amount: i.amount || '' }));
    const documents = allItems.filter(i => i.module === 'documents').map(i => ({ name: i.name, status: i.status, docType: i.docType || '', note: i.note || '' }));

    const poStmt = sqliteDb.prepare('SELECT * FROM purchase_orders WHERE project_id = ?');
    const pos = poStmt.all(id);

    const poItemsStmt = sqliteDb.prepare('SELECT * FROM po_items WHERE po_id = ? ORDER BY idx ASC');
    
    pos.forEach(po => {
      po.vendor = {
        name: po.vendorName || '',
        address: po.vendorAddress || '',
        phone: po.vendorPhone || '',
        email: po.vendorEmail || ''
      };
      po.shipTo = {
        name: po.shipToName || '',
        address: po.shipToAddress || '',
        phone: po.shipToPhone || '',
        email: po.shipToEmail || ''
      };
      
      delete po.vendorName; delete po.vendorAddress; delete po.vendorPhone; delete po.vendorEmail;
      delete po.shipToName; delete po.shipToAddress; delete po.shipToPhone; delete po.shipToEmail;

      po.items = poItemsStmt.all(po.id).map(it => ({
        name: it.name,
        desc: it.desc || '',
        qty: it.qty,
        unitPrice: it.unitPrice
      }));
    });

    return {
      id: proj.id,
      service: proj.service,
      name: proj.name,
      site: proj.site,
      tag: proj.tag || '',
      val: proj.val || '',
      team: proj.team || 'Unassigned',
      start: proj.start || '',
      delivery: proj.delivery || '—',
      stage: proj.stage,
      sub: proj.sub,
      status: proj.status,
      note: proj.note || '',
      pct: proj.pct,
      stages,
      assignees,
      moduleAssignees,
      materials,
      payments,
      documents,
      po: pos
    };
  }
}

async function getProjectsList() {
  if (supabase) {
    const { data, error } = await supabase.from('projects').select('id');
    if (error) throw error;
    const projects = await Promise.all((data || []).map(r => getProject(r.id)));
    return projects.filter(Boolean);
  } else {
    const stmt = sqliteDb.prepare('SELECT id FROM projects');
    return stmt.all().map(r => {
      const pStmt = sqliteDb.prepare('SELECT * FROM projects WHERE id = ?');
      const proj = pStmt.get(r.id);
      if (!proj) return null;

      const stagesStmt = sqliteDb.prepare('SELECT * FROM project_stages WHERE project_id = ? ORDER BY seq ASC');
      const stages = stagesStmt.all(r.id);

      const fieldsStmt = sqliteDb.prepare('SELECT * FROM stage_fields WHERE project_id = ?');
      const allFields = fieldsStmt.all(r.id);

      stages.forEach(st => {
        st.fields = allFields
          .filter(f => f.stage_id === st.id)
          .map(f => ({
            id: f.id,
            label: f.label,
            type: f.type,
            value: f.value || '',
            origName: f.origName || ''
          }));
        if (st.kind === null) delete st.kind;
      });

      const assignStmt = sqliteDb.prepare('SELECT * FROM project_assignees WHERE project_id = ?');
      const assignees = {};
      assignStmt.all(r.id).forEach(a => {
        assignees[a.stage_id] = a.person;
      });

      const modAssignStmt = sqliteDb.prepare('SELECT * FROM project_module_assignees WHERE project_id = ?');
      const moduleAssignees = { progress: '', materials: '', payments: '', documents: '' };
      modAssignStmt.all(r.id).forEach(ma => {
        moduleAssignees[ma.module] = ma.role;
      });

      const itemsStmt = sqliteDb.prepare('SELECT * FROM module_items WHERE project_id = ? ORDER BY idx ASC');
      const allItems = itemsStmt.all(r.id);

      const materials = allItems.filter(i => i.module === 'materials').map(i => ({ name: i.name, status: i.status, qty: i.qty || '', unit: i.unit || '', note: i.note || '' }));
      const payments = allItems.filter(i => i.module === 'payments').map(i => ({ name: i.name, status: i.status, amount: i.amount || '' }));
      const documents = allItems.filter(i => i.module === 'documents').map(i => ({ name: i.name, status: i.status, docType: i.docType || '', note: i.note || '' }));

      const poStmt = sqliteDb.prepare('SELECT * FROM purchase_orders WHERE project_id = ?');
      const pos = poStmt.all(r.id);

      const poItemsStmt = sqliteDb.prepare('SELECT * FROM po_items WHERE po_id = ? ORDER BY idx ASC');
      
      pos.forEach(po => {
        po.vendor = {
          name: po.vendorName || '',
          address: po.vendorAddress || '',
          phone: po.vendorPhone || '',
          email: po.vendorEmail || ''
        };
        po.shipTo = {
          name: po.shipToName || '',
          address: po.shipToAddress || '',
          phone: po.shipToPhone || '',
          email: po.shipToEmail || ''
        };
        
        delete po.vendorName; delete po.vendorAddress; delete po.vendorPhone; delete po.vendorEmail;
        delete po.shipToName; delete po.shipToAddress; delete po.shipToPhone; delete po.shipToEmail;

        po.items = poItemsStmt.all(po.id).map(it => ({
          name: it.name,
          desc: it.desc || '',
          qty: it.qty,
          unitPrice: it.unitPrice
        }));
      });

      return {
        id: proj.id,
        service: proj.service,
        name: proj.name,
        site: proj.site,
        tag: proj.tag || '',
        val: proj.val || '',
        team: proj.team || 'Unassigned',
        start: proj.start || '',
        delivery: proj.delivery || '—',
        stage: proj.stage,
        sub: proj.sub,
        status: proj.status,
        note: proj.note || '',
        pct: proj.pct,
        stages,
        assignees,
        moduleAssignees,
        materials,
        payments,
        documents,
        po: pos
      };
    }).filter(Boolean);
  }
}

async function updateProjectProgress(id, stage, sub, status, note, pct) {
  if (supabase) {
    const { error } = await supabase
      .from('projects')
      .update({ stage, sub, status, note: note || '', pct })
      .eq('id', id);
    if (error) throw error;
  } else {
    const stmt = sqliteDb.prepare(`
      UPDATE projects
      SET stage = ?, sub = ?, status = ?, note = ?, pct = ?
      WHERE id = ?
    `);
    stmt.run(stage, sub, status, note || '', pct, id);
  }
}

async function assignProjectTeam(id, team) {
  if (supabase) {
    const { error } = await supabase.from('projects').update({ team }).eq('id', id);
    if (error) throw error;
  } else {
    const stmt = sqliteDb.prepare('UPDATE projects SET team = ? WHERE id = ?');
    stmt.run(team, id);
  }
}

async function assignProjectStagePerson(id, stageId, person) {
  if (supabase) {
    if (person && person !== 'Unassigned') {
      const { error } = await supabase.from('project_assignees').upsert({
        project_id: id,
        stage_id: stageId,
        person
      });
      if (error) throw error;
    } else {
      const { error } = await supabase
        .from('project_assignees')
        .delete()
        .eq('project_id', id)
        .eq('stage_id', stageId);
      if (error) throw error;
    }
  } else {
    runSqliteTransaction(() => {
      if (person && person !== 'Unassigned') {
        const stmt = sqliteDb.prepare(`
          INSERT OR REPLACE INTO project_assignees (project_id, stage_id, person)
          VALUES (?, ?, ?)
        `);
        stmt.run(id, stageId, person);
      } else {
        const stmt = sqliteDb.prepare('DELETE FROM project_assignees WHERE project_id = ? AND stage_id = ?');
        stmt.run(id, stageId);
      }
    });
  }
}

async function addProjectStage(id, newStage, insertAt) {
  if (supabase) {
    // 1. Shift stages with sequence >= insertAt
    const { data: stages, error } = await supabase
      .from('project_stages')
      .select('*')
      .eq('project_id', id)
      .order('seq', { ascending: true });
    if (error) throw error;

    for (const st of (stages || [])) {
      if (st.seq >= insertAt) {
        const { error: uErr } = await supabase
          .from('project_stages')
          .update({ seq: st.seq + 1 })
          .eq('project_id', id)
          .eq('id', st.id);
        if (uErr) throw uErr;
      }
    }

    // 2. Insert new stage
    const { error: insErr } = await supabase.from('project_stages').insert({
      project_id: id,
      id: newStage.id,
      name: newStage.name,
      desc: newStage.desc || '',
      kind: newStage.kind || null,
      seq: insertAt
    });
    if (insErr) throw insErr;
  } else {
    runSqliteTransaction(() => {
      const shiftStmt = sqliteDb.prepare('UPDATE project_stages SET seq = seq + 1 WHERE project_id = ? AND seq >= ?');
      shiftStmt.run(id, insertAt);

      const insertStmt = sqliteDb.prepare(`
        INSERT INTO project_stages (project_id, id, name, desc, kind, seq)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      insertStmt.run(id, newStage.id, newStage.name, newStage.desc || '', newStage.kind || null, insertAt);
    });
  }
}

async function renameProjectStage(id, stageId, name) {
  if (supabase) {
    const { error } = await supabase
      .from('project_stages')
      .update({ name })
      .eq('project_id', id)
      .eq('id', stageId);
    if (error) throw error;
  } else {
    const stmt = sqliteDb.prepare('UPDATE project_stages SET name = ? WHERE project_id = ? AND id = ?');
    stmt.run(name, id, stageId);
  }
}

async function addStageField(projectId, stageId, field) {
  if (supabase) {
    const { error } = await supabase.from('stage_fields').insert({
      project_id: projectId,
      stage_id: stageId,
      id: field.id,
      label: field.label,
      type: field.type,
      value: field.value || '',
      origName: field.origName || ''
    });
    if (error) throw error;
  } else {
    const stmt = sqliteDb.prepare(`
      INSERT INTO stage_fields (project_id, stage_id, id, label, type, value, origName)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(projectId, stageId, field.id, field.label, field.type, field.value || '', field.origName || '');
  }
}

async function removeStageField(projectId, stageId, fieldId) {
  if (supabase) {
    const { error } = await supabase
      .from('stage_fields')
      .delete()
      .eq('project_id', projectId)
      .eq('stage_id', stageId)
      .eq('id', fieldId);
    if (error) throw error;
  } else {
    const stmt = sqliteDb.prepare('DELETE FROM stage_fields WHERE project_id = ? AND stage_id = ? AND id = ?');
    stmt.run(projectId, stageId, fieldId);
  }
}

async function updateStageFieldValue(projectId, stageId, fieldId, value, origName) {
  if (supabase) {
    const { error } = await supabase
      .from('stage_fields')
      .update({ value, origName: origName || '' })
      .eq('project_id', projectId)
      .eq('stage_id', stageId)
      .eq('id', fieldId);
    if (error) throw error;
  } else {
    const stmt = sqliteDb.prepare(`
      UPDATE stage_fields
      SET value = ?, origName = ?
      WHERE project_id = ? AND stage_id = ? AND id = ?
    `);
    stmt.run(value, origName || '', projectId, stageId, fieldId);
  }
}

async function assignProjectModuleRole(id, module, role) {
  if (supabase) {
    if (role) {
      const { error } = await supabase.from('project_module_assignees').upsert({
        project_id: id,
        module,
        role
      });
      if (error) throw error;
    } else {
      const { error } = await supabase
        .from('project_module_assignees')
        .delete()
        .eq('project_id', id)
        .eq('module', module);
      if (error) throw error;
    }
  } else {
    runSqliteTransaction(() => {
      if (role) {
        const stmt = sqliteDb.prepare(`
          INSERT OR REPLACE INTO project_module_assignees (project_id, module, role)
          VALUES (?, ?, ?)
        `);
        stmt.run(id, module, role);
      } else {
        const stmt = sqliteDb.prepare('DELETE FROM project_module_assignees WHERE project_id = ? AND module = ?');
        stmt.run(id, module);
      }
    });
  }
}

async function addModuleItem(id, module, item) {
  if (supabase) {
    const { data, error: countErr } = await supabase
      .from('module_items')
      .select('idx')
      .eq('project_id', id)
      .eq('module', module);
    if (countErr) throw countErr;

    const count = data ? data.length : 0;
    const { error: insErr } = await supabase.from('module_items').insert({
      project_id: id,
      module,
      idx: count,
      name: item.name,
      status: item.status || 'Pending',
      amount: item.amount || null,
      qty: item.qty || null,
      unit: item.unit || null,
      note: item.note || null,
      docType: item.docType || null
    });
    if (insErr) throw insErr;
  } else {
    runSqliteTransaction(() => {
      const idxStmt = sqliteDb.prepare('SELECT COUNT(*) as count FROM module_items WHERE project_id = ? AND module = ?');
      const idx = idxStmt.get(id, module).count;

      const stmt = sqliteDb.prepare(`
        INSERT INTO module_items (project_id, module, idx, name, status, amount, qty, unit, note, docType)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      stmt.run(
        id,
        module,
        idx,
        item.name,
        item.status || 'Pending',
        item.amount || null,
        item.qty || null,
        item.unit || null,
        item.note || null,
        item.docType || null
      );
    });
  }
}

async function toggleModuleItem(id, module, idx) {
  if (supabase) {
    const { data: item, error: getErr } = await supabase
      .from('module_items')
      .select('status')
      .eq('project_id', id)
      .eq('module', module)
      .eq('idx', idx)
      .maybeSingle();
    if (getErr) throw getErr;
    if (!item) return;

    const nextStatus = item.status === 'Done' ? 'Pending' : 'Done';
    const { error: updErr } = await supabase
      .from('module_items')
      .update({ status: nextStatus })
      .eq('project_id', id)
      .eq('module', module)
      .eq('idx', idx);
    if (updErr) throw updErr;
  } else {
    runSqliteTransaction(() => {
      const getStmt = sqliteDb.prepare('SELECT status FROM module_items WHERE project_id = ? AND module = ? AND idx = ?');
      const item = getStmt.get(id, module, idx);
      if (!item) return;

      const nextStatus = item.status === 'Done' ? 'Pending' : 'Done';
      const stmt = sqliteDb.prepare('UPDATE module_items SET status = ? WHERE project_id = ? AND module = ? AND idx = ?');
      stmt.run(nextStatus, id, module, idx);
    });
  }
}

async function createPurchaseOrder(projectId, po) {
  if (supabase) {
    const { error: poErr } = await supabase.from('purchase_orders').insert({
      project_id: projectId,
      id: po.id,
      requestNo: po.requestNo || '',
      shipVia: po.shipVia || '',
      fob: po.fob || '',
      shippingTerms: po.shippingTerms || '',
      taxPercent: po.taxPercent || 0,
      shippingFee: po.shippingFee || 0,
      status: po.status || 'Draft',
      raisedBy: po.raisedBy || '',
      date: po.date || '',
      emailedTo: po.emailedTo || null,
      vendorName: po.vendor.name || '',
      vendorAddress: po.vendor.address || '',
      vendorPhone: po.vendor.phone || '',
      vendorEmail: po.vendor.email || '',
      shipToName: po.shipTo.name || '',
      shipToAddress: po.shipTo.address || '',
      shipToPhone: po.shipTo.phone || '',
      shipToEmail: po.shipTo.email || ''
    });
    if (poErr) throw poErr;

    const itemsToInsert = (po.items || []).map((it, idx) => ({
      po_id: po.id,
      idx,
      name: it.name,
      desc: it.desc || '',
      qty: it.qty || 0,
      unitPrice: it.unitPrice || 0
    }));

    if (itemsToInsert.length > 0) {
      const { error: itemsErr } = await supabase.from('po_items').insert(itemsToInsert);
      if (itemsErr) throw itemsErr;
    }
  } else {
    runSqliteTransaction(() => {
      const stmt = sqliteDb.prepare(`
        INSERT INTO purchase_orders (
          project_id, id, requestNo, shipVia, fob, shippingTerms, taxPercent, shippingFee, status, raisedBy, date, emailedTo,
          vendorName, vendorAddress, vendorPhone, vendorEmail,
          shipToName, shipToAddress, shipToPhone, shipToEmail
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      stmt.run(
        projectId,
        po.id,
        po.requestNo || '',
        po.shipVia || '',
        po.fob || '',
        po.shippingTerms || '',
        po.taxPercent || 0,
        po.shippingFee || 0,
        po.status || 'Draft',
        po.raisedBy || '',
        po.date || '',
        po.emailedTo || null,
        po.vendor.name || '',
        po.vendor.address || '',
        po.vendor.phone || '',
        po.vendor.email || '',
        po.shipTo.name || '',
        po.shipTo.address || '',
        po.shipTo.phone || '',
        po.shipTo.email || ''
      );

      const itemStmt = sqliteDb.prepare(`
        INSERT INTO po_items (po_id, idx, name, desc, qty, unitPrice)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      (po.items || []).forEach((it, idx) => {
        itemStmt.run(po.id, idx, it.name, it.desc || '', it.qty || 0, it.unitPrice || 0);
      });
    });
  }
}

async function updatePurchaseOrderStatus(projectId, poId, status) {
  if (supabase) {
    const { error } = await supabase
      .from('purchase_orders')
      .update({ status })
      .eq('project_id', projectId)
      .eq('id', poId);
    if (error) throw error;
  } else {
    const stmt = sqliteDb.prepare('UPDATE purchase_orders SET status = ? WHERE project_id = ? AND id = ?');
    stmt.run(status, projectId, poId);
  }
}

async function updatePurchaseOrderEmail(projectId, poId, emailedTo) {
  if (supabase) {
    const { error } = await supabase
      .from('purchase_orders')
      .update({ emailedTo })
      .eq('project_id', projectId)
      .eq('id', poId);
    if (error) throw error;
  } else {
    const stmt = sqliteDb.prepare('UPDATE purchase_orders SET emailedTo = ? WHERE project_id = ? AND id = ?');
    stmt.run(emailedTo, projectId, poId);
  }
}

async function getUpdatesList(limit = 15) {
  if (supabase) {
    const { data, error } = await supabase
      .from('updates')
      .select('*')
      .order('at', { ascending: false })
      .order('id', { ascending: false })
      .limit(limit);
    if (error) throw error;
    return (data || []).map(u => ({
      at: Number(u.at),
      role: u.role,
      roleName: u.roleName,
      projectId: u.projectId,
      projectName: u.projectName,
      stage: u.stage,
      notify: !!u.notify,
      module: u.module || undefined,
      moduleRole: u.moduleRole || undefined,
      text: u.text
    }));
  } else {
    const stmt = sqliteDb.prepare('SELECT * FROM updates ORDER BY at DESC, id DESC LIMIT ?');
    return stmt.all(limit).map(u => ({
      at: u.at,
      role: u.role,
      roleName: u.roleName,
      projectId: u.projectId,
      projectName: u.projectName,
      stage: u.stage,
      notify: u.notify === 1,
      module: u.module || undefined,
      moduleRole: u.moduleRole || undefined,
      text: u.text
    }));
  }
}

async function addUpdate(u) {
  if (supabase) {
    const { error } = await supabase.from('updates').insert({
      at: u.at || Date.now(),
      role: u.role || null,
      roleName: u.roleName || null,
      projectId: u.projectId || null,
      projectName: u.projectName || null,
      stage: u.stage || null,
      notify: !!u.notify,
      module: u.module || null,
      moduleRole: u.moduleRole || null,
      text: u.text
    });
    if (error) throw error;
  } else {
    const stmt = sqliteDb.prepare(`
      INSERT INTO updates (at, role, roleName, projectId, projectName, stage, notify, module, moduleRole, text)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      u.at || Date.now(),
      u.role || null,
      u.roleName || null,
      u.projectId || null,
      u.projectName || null,
      u.stage || null,
      u.notify ? 1 : 0,
      u.module || null,
      u.moduleRole || null,
      u.text
    );
  }
}

async function clearUpdates() {
  if (supabase) {
    const { error } = await supabase.from('updates').delete().neq('text', '');
    if (error) throw error;
  } else {
    sqliteDb.exec('DELETE FROM updates');
  }
}

async function clearAllProjects() {
  if (supabase) {
    const { error: pErr } = await supabase.from('projects').delete().neq('name', '');
    if (pErr) throw pErr;
    const { error: uErr } = await supabase.from('updates').delete().neq('text', '');
    if (uErr) throw uErr;
  } else {
    runSqliteTransaction(() => {
      sqliteDb.exec('DELETE FROM projects');
      sqliteDb.exec('DELETE FROM updates');
    });
  }
}

module.exports = {
  supabase,
  initDb,
  insertUser,
  getUser,
  saveSession,
  getSession,
  deleteSession,
  cleanExpiredSessions,
  getAllSessions,
  createProject,
  getProject,
  getProjectsList,
  updateProjectProgress,
  assignProjectTeam,
  assignProjectStagePerson,
  addProjectStage,
  renameProjectStage,
  addStageField,
  removeStageField,
  updateStageFieldValue,
  assignProjectModuleRole,
  addModuleItem,
  toggleModuleItem,
  createPurchaseOrder,
  updatePurchaseOrderStatus,
  updatePurchaseOrderEmail,
  getUpdatesList,
  addUpdate,
  clearUpdates,
  clearAllProjects
};
