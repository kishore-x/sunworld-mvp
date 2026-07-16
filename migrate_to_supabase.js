// migrate_to_supabase.js
require('dotenv').config();
const { DatabaseSync } = require('node:sqlite');
const { createClient } = require('@supabase/supabase-js');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, 'sunworld.db');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;

if (!supabaseUrl || supabaseUrl === 'YOUR_SUPABASE_PROJECT_URL' || !supabaseKey || supabaseKey === 'YOUR_SUPABASE_SERVICE_ROLE_KEY') {
  console.error('\n[Error] Supabase credentials are not configured in your .env file.');
  console.error('Please open your .env file, add your SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY, and run this script again.\n');
  process.exit(1);
}

if (!fs.existsSync(DB_PATH)) {
  console.error(`\n[Error] Local SQLite database not found at ${DB_PATH}.`);
  console.error('Start the server first to seed the local database, or ensure sunworld.db is present.\n');
  process.exit(1);
}

const sqliteDb = new DatabaseSync(DB_PATH);
const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: { persistSession: false }
});

async function runMigration() {
  console.log('\n============================================================');
  console.log('🚀 Starting Data Migration: SQLite (Local) -> Supabase (Cloud)');
  console.log('============================================================\n');

  try {
    // 1. Migrate Users
    console.log('🔄 Migrating: users...');
    const users = sqliteDb.prepare('SELECT * FROM users').all();
    if (users.length > 0) {
      const payload = users.map(u => ({
        user: u.user,
        passHash: u.passHash,
        role: u.role,
        name: u.name,
        canGeneral: u.canGeneral === 1,
        canSiteExecution: u.canSiteExecution === 1,
        person: u.person
      }));
      const { error } = await supabase.from('users').upsert(payload);
      if (error) throw error;
      console.log(`✅ Successfully migrated ${users.length} users.`);
    } else {
      console.log('ℹ️ No users to migrate.');
    }

    // 2. Migrate Projects
    console.log('\n🔄 Migrating: projects...');
    const projects = sqliteDb.prepare('SELECT * FROM projects').all();
    if (projects.length > 0) {
      const payload = projects.map(p => ({
        id: p.id,
        service: p.service,
        name: p.name,
        site: p.site,
        tag: p.tag,
        val: p.val,
        team: p.team,
        start: p.start,
        delivery: p.delivery,
        stage: p.stage,
        sub: p.sub,
        status: p.status,
        note: p.note,
        pct: p.pct
      }));
      const { error } = await supabase.from('projects').upsert(payload);
      if (error) throw error;
      console.log(`✅ Successfully migrated ${projects.length} projects.`);
    } else {
      console.log('ℹ️ No projects to migrate.');
    }

    // 3. Migrate Project Stages
    console.log('\n🔄 Migrating: project_stages...');
    const stages = sqliteDb.prepare('SELECT * FROM project_stages').all();
    if (stages.length > 0) {
      const payload = stages.map(s => ({
        project_id: s.project_id,
        id: s.id,
        name: s.name,
        desc: s.desc,
        kind: s.kind,
        seq: s.seq
      }));
      const { error } = await supabase.from('project_stages').upsert(payload);
      if (error) throw error;
      console.log(`✅ Successfully migrated ${stages.length} project stages.`);
    } else {
      console.log('ℹ️ No project stages to migrate.');
    }

    // 4. Migrate Stage Fields
    console.log('\n🔄 Migrating: stage_fields...');
    const fields = sqliteDb.prepare('SELECT * FROM stage_fields').all();
    if (fields.length > 0) {
      const payload = fields.map(f => ({
        project_id: f.project_id,
        stage_id: f.stage_id,
        id: f.id,
        label: f.label,
        type: f.type,
        value: f.value,
        origName: f.origName
      }));
      const { error } = await supabase.from('stage_fields').upsert(payload);
      if (error) throw error;
      console.log(`✅ Successfully migrated ${fields.length} stage fields.`);
    } else {
      console.log('ℹ️ No stage fields to migrate.');
    }

    // 5. Migrate Project Assignees
    console.log('\n🔄 Migrating: project_assignees...');
    const assignees = sqliteDb.prepare('SELECT * FROM project_assignees').all();
    if (assignees.length > 0) {
      const payload = assignees.map(a => ({
        project_id: a.project_id,
        stage_id: a.stage_id,
        person: a.person
      }));
      const { error } = await supabase.from('project_assignees').upsert(payload);
      if (error) throw error;
      console.log(`✅ Successfully migrated ${assignees.length} project assignees.`);
    } else {
      console.log('ℹ️ No project assignees to migrate.');
    }

    // 6. Migrate Project Module Assignees
    console.log('\n🔄 Migrating: project_module_assignees...');
    const modAssignees = sqliteDb.prepare('SELECT * FROM project_module_assignees').all();
    if (modAssignees.length > 0) {
      const payload = modAssignees.map(m => ({
        project_id: m.project_id,
        module: m.module,
        role: m.role
      }));
      const { error } = await supabase.from('project_module_assignees').upsert(payload);
      if (error) throw error;
      console.log(`✅ Successfully migrated ${modAssignees.length} module assignees.`);
    } else {
      console.log('ℹ️ No module assignees to migrate.');
    }

    // 7. Migrate Module Items
    console.log('\n🔄 Migrating: module_items...');
    const items = sqliteDb.prepare('SELECT * FROM module_items').all();
    if (items.length > 0) {
      const payload = items.map(i => ({
        project_id: i.project_id,
        module: i.module,
        idx: i.idx,
        name: i.name,
        status: i.status,
        amount: i.amount,
        qty: i.qty,
        unit: i.unit,
        note: i.note,
        docType: i.docType
      }));
      const { error } = await supabase.from('module_items').upsert(payload);
      if (error) throw error;
      console.log(`✅ Successfully migrated ${items.length} module items.`);
    } else {
      console.log('ℹ️ No module items to migrate.');
    }

    // 8. Migrate Purchase Orders
    console.log('\n🔄 Migrating: purchase_orders...');
    const pos = sqliteDb.prepare('SELECT * FROM purchase_orders').all();
    if (pos.length > 0) {
      const payload = pos.map(po => ({
        project_id: po.project_id,
        id: po.id,
        requestNo: po.requestNo,
        shipVia: po.shipVia,
        fob: po.fob,
        shippingTerms: po.shippingTerms,
        taxPercent: po.taxPercent,
        shippingFee: po.shippingFee,
        status: po.status,
        raisedBy: po.raisedBy,
        date: po.date,
        emailedTo: po.emailedTo,
        vendorName: po.vendorName,
        vendorAddress: po.vendorAddress,
        vendorPhone: po.vendorPhone,
        vendorEmail: po.vendorEmail,
        shipToName: po.shipToName,
        shipToAddress: po.shipToAddress,
        shipToPhone: po.shipToPhone,
        shipToEmail: po.shipToEmail
      }));
      const { error } = await supabase.from('purchase_orders').upsert(payload);
      if (error) throw error;
      console.log(`✅ Successfully migrated ${pos.length} purchase orders.`);
    } else {
      console.log('ℹ️ No purchase orders to migrate.');
    }

    // 9. Migrate Purchase Order Items
    console.log('\n🔄 Migrating: po_items...');
    const poItems = sqliteDb.prepare('SELECT * FROM po_items').all();
    if (poItems.length > 0) {
      const payload = poItems.map(it => ({
        po_id: it.po_id,
        idx: it.idx,
        name: it.name,
        desc: it.desc,
        qty: it.qty,
        unitPrice: it.unitPrice
      }));
      const { error } = await supabase.from('po_items').upsert(payload);
      if (error) throw error;
      console.log(`✅ Successfully migrated ${poItems.length} purchase order items.`);
    } else {
      console.log('ℹ️ No purchase order items to migrate.');
    }

    // 10. Migrate Updates
    console.log('\n🔄 Migrating: updates...');
    const updates = sqliteDb.prepare('SELECT * FROM updates').all();
    if (updates.length > 0) {
      const payload = updates.map(u => ({
        at: u.at,
        role: u.role,
        roleName: u.roleName,
        projectId: u.projectId,
        projectName: u.projectName,
        stage: u.stage,
        notify: u.notify === 1,
        module: u.module,
        moduleRole: u.moduleRole,
        text: u.text
      }));
      const { error } = await supabase.from('updates').insert(payload);
      if (error) throw error;
      console.log(`✅ Successfully migrated ${updates.length} update logs.`);
    } else {
      console.log('ℹ️ No update logs to migrate.');
    }

    // 11. Migrate Active Sessions
    console.log('\n🔄 Migrating: sessions...');
    const sessions = sqliteDb.prepare('SELECT * FROM sessions').all();
    if (sessions.length > 0) {
      const payload = sessions.map(s => ({
        sid: s.sid,
        user: s.user,
        role: s.role,
        name: s.name,
        canGeneral: s.canGeneral === 1,
        canSiteExecution: s.canSiteExecution === 1,
        person: s.person,
        csrf: s.csrf,
        createdAt: s.createdAt
      }));
      const { error } = await supabase.from('sessions').upsert(payload);
      if (error) throw error;
      console.log(`✅ Successfully migrated ${sessions.length} active sessions.`);
    } else {
      console.log('ℹ️ No active sessions to migrate.');
    }

    console.log('\n============================================================');
    console.log('🎉 Migration Completed Successfully!');
    console.log('============================================================\n');

  } catch (err) {
    console.error('\n❌ Migration failed due to an error:');
    console.error(err);
    console.log();
    process.exit(1);
  }
}

runMigration();
