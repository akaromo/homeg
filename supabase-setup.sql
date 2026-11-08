-- ============================================================
-- KCS Homegrown lead portal - Supabase schema
-- Project ref: pefyqrhzvjxoboaoecvc
--
-- Run this once in the Supabase SQL editor
-- (Dashboard -> SQL Editor -> New query -> paste -> Run).
-- The portal server uses the service role key, which bypasses RLS.
-- ============================================================

-- Portal settings: LeadByte API key + campaign defaults (single row, id = 1)
create table if not exists public.portal_settings (
  id               integer primary key,
  leadbyte_x_key   text,
  campaign         jsonb not null default '{}'::jsonb,
  updated_at       timestamptz default now()
);

-- Portal accounts (username, role, scrypt password salt + hash)
create table if not exists public.portal_users (
  username     text primary key,
  role         text not null default 'agent',
  salt         text,
  hash         text,
  must_change  boolean not null default true
);

-- Lead submission log
create table if not exists public.lead_submissions (
  id              bigserial primary key,
  created_at      timestamptz not null default now(),
  agent_username  text,
  payload         jsonb,
  result          jsonb,
  status          text,
  code            text,
  queue_id        text
);

create index if not exists lead_submissions_created_at_idx
  on public.lead_submissions (created_at desc);

-- Lock the tables down: only the service role (server) may read/write them.
alter table public.portal_settings   enable row level security;
alter table public.portal_users      enable row level security;
alter table public.lead_submissions  enable row level security;
