-- Stemline Bunker Desk — schema
-- Run once:  psql "$DATABASE_URL" -f schema.sql

-- One row per signed-in trader. Refresh tokens live here, never in the browser.
create table if not exists trader (
  id             text primary key,          -- Entra object id (oid)
  display_name   text not null,
  email          text not null,
  home_account_id text not null,            -- MSAL account key for silent refresh
  token_cache    text not null,             -- serialized MSAL cache (contains refresh token)
  delta_link     text,                      -- Graph delta cursor for the inbox
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- Every message the poll has seen. internetMessageId dedupes — a delta query
-- will hand you the same message more than once.
create table if not exists message (
  id                  text primary key,     -- Graph message id
  trader_id           text not null references trader(id) on delete cascade,
  internet_message_id text not null,
  conversation_id     text,
  subject             text,
  from_name           text,
  from_address        text,
  body                text not null,
  received_at         timestamptz not null,
  kind                text not null default 'unknown',  -- enquiry | quote | other
  seen_at             timestamptz not null default now(),
  unique (trader_id, internet_message_id)
);

-- A client's request for a stem. Created from a parsed enquiry email.
create table if not exists enquiry (
  id           bigserial primary key,
  trader_id    text not null references trader(id) on delete cascade,
  message_id   text references message(id) on delete set null,
  client       text,
  vessel       text,
  imo          text,
  port         text,                        -- UN/LOCODE
  agent        text,
  window_text  text,
  lines        jsonb not null default '[]', -- [{grade, quantity, unit, spec}]
  status       text not null default 'open',
  created_at   timestamptz not null default now()
);

-- One supplier's price for one enquiry. raw_text is kept verbatim, always.
create table if not exists vendor_quote (
  id           bigserial primary key,
  enquiry_id   bigint not null references enquiry(id) on delete cascade,
  message_id   text references message(id) on delete set null,
  vendor       text not null,
  raw_text     text not null,
  parsed       jsonb not null,              -- {lines: {GRADE: {basePrice, components[], ...}}}
  confidence   real not null default 0,
  unmapped     jsonb not null default '[]', -- phrases the parser could not price
  valid_until  timestamptz,
  received_at  timestamptz not null default now()
);

-- The audit trail. Not optional: every quote sent, with the cost basis behind it.
create table if not exists client_quote (
  id              bigserial primary key,
  enquiry_id      bigint not null references enquiry(id) on delete cascade,
  vendor_quote_id bigint references vendor_quote(id) on delete set null,
  margin_basis    text not null,
  margin_value    numeric not null,
  cost_breakdown  jsonb not null,           -- full component trail at time of send
  body            text not null,
  sent_at         timestamptz not null default now(),
  graph_message_id text
);

create index if not exists message_trader_received on message (trader_id, received_at desc);
create index if not exists quote_enquiry on vendor_quote (enquiry_id, received_at desc);
