-- =================================================================
-- TAGLINE — Database Schema
-- =================================================================
-- Run this in: Supabase Dashboard → SQL Editor → New Query → Paste → Run
-- =================================================================

-- ============================================================
-- PRODUCTS
-- ============================================================
create table if not exists products (
  id text primary key,
  name text not null,
  color text,
  price_cents integer not null check (price_cents >= 0),
  category text not null,
  tag text, -- 'new', 'limited', 'restock', 'sold_out', null
  stock integer not null default 0,
  active boolean not null default true,
  stripe_price_id text, -- filled in once you create products in Stripe
  description text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists idx_products_category on products(category);
create index if not exists idx_products_active on products(active);

-- ============================================================
-- CUSTOMERS / PROFILES
-- ============================================================
-- Linked to Supabase Auth users via auth.users.id
create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text unique not null,
  full_name text,
  phone text,
  shipping_address jsonb, -- { line1, line2, city, state, zip, country }
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Auto-create profile when a new auth user signs up
create or replace function handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, full_name)
  values (new.id, new.email, new.raw_user_meta_data->>'full_name');
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

-- ============================================================
-- ORDERS
-- ============================================================
create table if not exists orders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references profiles(id) on delete set null,
  email text not null,
  status text not null default 'pending', -- pending, paid, shipped, delivered, cancelled, refunded
  stripe_session_id text unique,
  stripe_payment_intent text,
  subtotal_cents integer not null,
  shipping_cents integer not null default 0,
  tax_cents integer not null default 0,
  total_cents integer not null,
  shipping_address jsonb,
  items jsonb not null, -- [{ product_id, name, color, price_cents, quantity }]
  notes text,
  tracking_number text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists idx_orders_user on orders(user_id);
create index if not exists idx_orders_email on orders(email);
create index if not exists idx_orders_status on orders(status);
create index if not exists idx_orders_created on orders(created_at desc);

-- NowPayments (crypto) invoice support — orders paid via crypto get a
-- nowpayments_invoice_id instead of stripe_session_id. Webhook lookups
-- use this column. Safe to run on existing DB (uses if not exists).
alter table orders add column if not exists nowpayments_invoice_id text unique;
create index if not exists idx_orders_np_invoice on orders(nowpayments_invoice_id);

-- ============================================================
-- NEWSLETTER SUBSCRIBERS
-- ============================================================
create table if not exists subscribers (
  id uuid primary key default gen_random_uuid(),
  email text unique not null,
  source text default 'website', -- 'website', 'checkout', 'manual'
  active boolean default true,
  unsubscribed_at timestamptz,
  created_at timestamptz default now()
);

create index if not exists idx_subscribers_email on subscribers(email);

-- ============================================================
-- CONTACT MESSAGES
-- ============================================================
create table if not exists contact_messages (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text not null,
  subject text,
  message text not null,
  status text default 'new', -- 'new', 'read', 'replied', 'archived'
  created_at timestamptz default now()
);

create index if not exists idx_contact_status on contact_messages(status);
create index if not exists idx_contact_created on contact_messages(created_at desc);

-- ============================================================
-- ROW LEVEL SECURITY (RLS)
-- ============================================================
-- Lock down direct table access. Server uses service_role key to bypass.
-- Browser can only read products and update their own profile/orders.

-- PRODUCTS: anyone can read active ones
alter table products enable row level security;
drop policy if exists "products_read_active" on products;
create policy "products_read_active" on products
  for select using (active = true);

-- PROFILES: only owner can read/update their own
alter table profiles enable row level security;
drop policy if exists "profiles_owner_read" on profiles;
create policy "profiles_owner_read" on profiles
  for select using (auth.uid() = id);
drop policy if exists "profiles_owner_update" on profiles;
create policy "profiles_owner_update" on profiles
  for update using (auth.uid() = id);

-- ORDERS: users can only see their own orders
alter table orders enable row level security;
drop policy if exists "orders_owner_read" on orders;
create policy "orders_owner_read" on orders
  for select using (auth.uid() = user_id);

-- SUBSCRIBERS: server-only writes (no public access needed)
alter table subscribers enable row level security;

-- CONTACT MESSAGES: server-only writes
alter table contact_messages enable row level security;

-- ============================================================
-- WEBHOOK IDEMPOTENCY
-- ============================================================
-- Stripe occasionally redelivers the same webhook event (transient
-- network errors, retries on our 5xx). Inserting event.id into this
-- table before processing means a duplicate insert collides on the
-- primary key and we know to skip the work — preventing double
-- stock decrements, duplicate confirmation emails, etc.
create table if not exists processed_webhook_events (
  event_id text primary key,
  event_type text not null,
  processed_at timestamptz default now()
);

create index if not exists idx_processed_events_at on processed_webhook_events(processed_at);

-- Lock down — only the server (service role) writes here
alter table processed_webhook_events enable row level security;

-- ============================================================
-- ATOMIC STOCK DECREMENT
-- ============================================================
-- Decrements stock if sufficient is available. Returns true on success,
-- false if stock was insufficient (oversold case — webhook should log).
--
-- The single UPDATE statement is the atomicity guarantee — Postgres
-- holds a row lock for the duration, so two concurrent decrements
-- can't both succeed when there's only stock for one. This replaces
-- the old `greatest(0, stock - qty)` version which silently clamped
-- to zero and gave the caller no signal that they oversold.
--
-- Drop the old void-returning version first if it exists. Postgres won't
-- let `create or replace` change the return type, so a fresh schema run
-- on a DB that has the old function would fail without this.
drop function if exists decrement_stock(text, integer);

create function decrement_stock(product_id text, qty integer)
returns boolean
language plpgsql
security definer
as $$
declare
  rows_affected integer;
begin
  update products
  set stock = stock - qty,
      updated_at = now()
  where id = product_id and stock >= qty;
  get diagnostics rows_affected = row_count;
  return rows_affected > 0;
end;
$$;

-- ============================================================
-- SEED DATA — 24 white products from your homepage
-- ============================================================
insert into products (id, name, color, price_cents, category, tag, stock, description) values
  ('ascend-hoodie',     'Ascend Hoodie',     'Cream',         14800, 'Outerwear',    'new',     50, 'Pullover hoodie in heavyweight cream cotton.'),
  ('halo-zip',          'Halo Zip',          'Bone',          16500, 'Outerwear',    null,      40, 'Full-zip hoodie with metal hardware.'),
  ('origin-tee',        'Origin Tee',        'Ivory',          5800, 'Tops',         null,     100, 'Heavyweight tee in soft ivory.'),
  ('sigil-tank',        'Sigil Tank',        'White',          7800, 'Tops',         null,      80, 'Performance tank with embroidered detail.'),
  ('vesper-long',       'Vesper Long',       'Pearl',          9200, 'Tops',         'restock', 60, 'Long-sleeve top in pearl white.'),
  ('path-jogger',       'Path Jogger',       'Bone',          11800, 'Bottoms',      null,      45, 'Tapered jogger with side pockets.'),
  ('trial-short',       'Trial Short',       'Ivory',          7200, 'Bottoms',      null,      70, 'Lined training short.'),
  ('cloud-crew',        'Cloud Crew',        'Fog',           12800, 'Outerwear',    null,      50, 'Crew-neck sweater in fog white.'),
  ('crown-cap',         'Crown Cap',         'White',          4800, 'Accessories',  null,     120, 'Six-panel cap with embroidered logo.'),
  ('halo-runner',       'Halo Runner',       'Triple White',  21500, 'Footwear',     'limited', 25, 'Limited-edition runner in triple white.'),
  ('aether-bra',        'Aether Bra',        'Pearl',          6800, 'Tops',         null,      75, 'Medium-support sports bra.'),
  ('aether-legging',    'Aether Legging',    'White',          9800, 'Bottoms',      null,      60, 'High-rise legging with side pockets.'),
  ('reign-bomber',      'Reign Bomber',      'Bone',          24500, 'Outerwear',    'new',     30, 'Lightweight bomber with elastic trim.'),
  ('velocity-track',    'Velocity Track',    'Ivory',         18500, 'Outerwear',    null,      35, 'Track jacket with side stripes.'),
  ('vow-beanie',        'Vow Beanie',        'Cream',          4200, 'Accessories',  null,     150, 'Ribbed knit beanie.'),
  ('anthem-polo',       'Anthem Polo',       'White',          8800, 'Tops',         null,      55, 'Knit polo with three-button placket.'),
  ('lumen-crop',        'Lumen Crop',        'Pearl',          5400, 'Tops',         null,      70, 'Cropped fit tee.'),
  ('pilgrim-pant',      'Pilgrim Pant',      'Ivory',         12800, 'Bottoms',      null,      40, 'Wide-leg track pant.'),
  ('spirit-shell',      'Spirit Shell',      'White',         19800, 'Outerwear',    null,      30, 'Lightweight windbreaker.'),
  ('echo-vest',         'Echo Vest',         'Bone',          15500, 'Outerwear',    null,      35, 'Quilted vest.'),
  ('verse-henley',      'Verse Henley',      'Cream',          8400, 'Tops',         null,      55, 'Three-button henley in cream.'),
  ('sole-sock',         'Sole Sock',         'White Pair',     2400, 'Accessories',  null,     200, 'Crew sock, pack of one pair.'),
  ('pulse-band',        'Pulse Band',        'White',          2200, 'Accessories',  null,     180, 'Sweat headband.'),
  ('quill-tote',        'Quill Tote',        'Canvas White',   3800, 'Accessories',  'sold_out', 0, 'Heavy canvas tote with embroidered logo.')
on conflict (id) do nothing;
