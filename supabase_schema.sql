-- Supabase SQL Schema for Sunworld Command Center
-- Paste this script into the Supabase SQL Editor to initialize all tables.

-- Drop existing tables if they exist (clean setup)
DROP TABLE IF EXISTS po_items CASCADE;
DROP TABLE IF EXISTS purchase_orders CASCADE;
DROP TABLE IF EXISTS module_items CASCADE;
DROP TABLE IF EXISTS project_module_assignees CASCADE;
DROP TABLE IF EXISTS project_assignees CASCADE;
DROP TABLE IF EXISTS stage_fields CASCADE;
DROP TABLE IF EXISTS project_stages CASCADE;
DROP TABLE IF EXISTS projects CASCADE;
DROP TABLE IF EXISTS updates CASCADE;
DROP TABLE IF EXISTS sessions CASCADE;
DROP TABLE IF EXISTS users CASCADE;

-- 1. Users Table
CREATE TABLE users (
  "user" TEXT PRIMARY KEY,
  "passHash" TEXT NOT NULL,
  "role" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "canGeneral" BOOLEAN NOT NULL DEFAULT FALSE,
  "canSiteExecution" BOOLEAN NOT NULL DEFAULT FALSE,
  "person" TEXT
);

-- 2. Projects Table
CREATE TABLE projects (
  "id" TEXT PRIMARY KEY,
  "service" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "site" TEXT NOT NULL,
  "tag" TEXT DEFAULT '',
  "val" TEXT DEFAULT '₹0.0 L',
  "team" TEXT DEFAULT 'Unassigned',
  "start" TEXT DEFAULT '',
  "delivery" TEXT DEFAULT '—',
  "stage" INTEGER NOT NULL DEFAULT 1,
  "sub" INTEGER NOT NULL DEFAULT 0,
  "status" TEXT NOT NULL DEFAULT 'ok',
  "note" TEXT DEFAULT '',
  "pct" INTEGER NOT NULL DEFAULT 0
);

-- 3. Project Stages Table
CREATE TABLE project_stages (
  "project_id" TEXT NOT NULL REFERENCES projects("id") ON DELETE CASCADE,
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "desc" TEXT DEFAULT '',
  "kind" TEXT,
  "seq" INTEGER NOT NULL,
  PRIMARY KEY ("project_id", "id")
);

-- 4. Stage Fields Table
CREATE TABLE stage_fields (
  "project_id" TEXT NOT NULL,
  "stage_id" TEXT NOT NULL,
  "id" TEXT NOT NULL,
  "label" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "value" TEXT DEFAULT '',
  "origName" TEXT DEFAULT '',
  PRIMARY KEY ("project_id", "stage_id", "id"),
  FOREIGN KEY ("project_id", "stage_id") REFERENCES project_stages("project_id", "id") ON DELETE CASCADE
);

-- 5. Project Assignees Table
CREATE TABLE project_assignees (
  "project_id" TEXT NOT NULL,
  "stage_id" TEXT NOT NULL,
  "person" TEXT NOT NULL,
  PRIMARY KEY ("project_id", "stage_id"),
  FOREIGN KEY ("project_id", "stage_id") REFERENCES project_stages("project_id", "id") ON DELETE CASCADE
);

-- 6. Project Module Assignees Table
CREATE TABLE project_module_assignees (
  "project_id" TEXT NOT NULL REFERENCES projects("id") ON DELETE CASCADE,
  "module" TEXT NOT NULL, -- 'progress', 'materials', 'payments', 'documents'
  "role" TEXT NOT NULL,
  PRIMARY KEY ("project_id", "module")
);

-- 7. Module Items Table
CREATE TABLE module_items (
  "project_id" TEXT NOT NULL REFERENCES projects("id") ON DELETE CASCADE,
  "module" TEXT NOT NULL, -- 'materials', 'payments', 'documents'
  "idx" INTEGER NOT NULL,
  "name" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'Pending',
  "amount" TEXT,
  "qty" TEXT,
  "unit" TEXT,
  "note" TEXT,
  "docType" TEXT,
  PRIMARY KEY ("project_id", "module", "idx")
);

-- 8. Purchase Orders Table
CREATE TABLE purchase_orders (
  "project_id" TEXT NOT NULL REFERENCES projects("id") ON DELETE CASCADE,
  "id" TEXT PRIMARY KEY,
  "requestNo" TEXT DEFAULT '',
  "shipVia" TEXT DEFAULT '',
  "fob" TEXT DEFAULT '',
  "shippingTerms" TEXT DEFAULT '',
  "taxPercent" NUMERIC NOT NULL DEFAULT 0,
  "shippingFee" NUMERIC NOT NULL DEFAULT 0,
  "status" TEXT NOT NULL DEFAULT 'Draft',
  "raisedBy" TEXT DEFAULT '',
  "date" TEXT DEFAULT '',
  "emailedTo" TEXT,
  "vendorName" TEXT DEFAULT '',
  "vendorAddress" TEXT DEFAULT '',
  "vendorPhone" TEXT DEFAULT '',
  "vendorEmail" TEXT DEFAULT '',
  "shipToName" TEXT DEFAULT '',
  "shipToAddress" TEXT DEFAULT '',
  "shipToPhone" TEXT DEFAULT '',
  "shipToEmail" TEXT DEFAULT ''
);

-- 9. PO Line Items Table
CREATE TABLE po_items (
  "po_id" TEXT NOT NULL REFERENCES purchase_orders("id") ON DELETE CASCADE,
  "idx" INTEGER NOT NULL,
  "name" TEXT NOT NULL,
  "desc" TEXT DEFAULT '',
  "qty" NUMERIC NOT NULL DEFAULT 0,
  "unitPrice" NUMERIC NOT NULL DEFAULT 0,
  PRIMARY KEY ("po_id", "idx")
);

-- 10. Activity Log / Updates Table
CREATE TABLE updates (
  "id" BIGSERIAL PRIMARY KEY,
  "at" BIGINT NOT NULL,
  "role" TEXT,
  "roleName" TEXT,
  "projectId" TEXT,
  "projectName" TEXT,
  "stage" INTEGER,
  "notify" BOOLEAN NOT NULL DEFAULT FALSE,
  "module" TEXT,
  "moduleRole" TEXT,
  "text" TEXT NOT NULL
);

-- 11. Sessions Table (Persistent server sessions)
CREATE TABLE sessions (
  "sid" TEXT PRIMARY KEY,
  "user" TEXT NOT NULL,
  "role" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "canGeneral" BOOLEAN NOT NULL DEFAULT FALSE,
  "canSiteExecution" BOOLEAN NOT NULL DEFAULT FALSE,
  "person" TEXT,
  "csrf" TEXT NOT NULL,
  "createdAt" BIGINT NOT NULL
);
