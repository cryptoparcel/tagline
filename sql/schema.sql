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
  tag text, -- 'New', 'Featured', 'Limited', 'Restock', 'Sold Out', null
  stock integer not null default 0,
  active boolean not null default true,
  stripe_price_id text, -- filled in once you create products in Stripe
  description text,
  image_url text, -- public http(s) URL of the product photo. Falls back
                  -- to /images/products/{id}.jpg if null.
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Add image_url to existing deployments that pre-date this column
alter table products add column if not exists image_url text;

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
-- SEED DATA — 24 product slots, real Tagline Apparel data
-- ============================================================
-- Original 24 IDs preserved (so they stay aligned with the static
-- card layout in index.html and existing carts/wishlists). Real
-- names, prices, and image URLs from the live Tagline Apparel
-- catalog. Re-run safely: ON CONFLICT DO UPDATE refreshes existing
-- rows. Cleanup of any stale 33-product seed at the top.

-- Cleanup: in case a previous run installed the 33-product catalog
-- with different IDs, remove those (they were placeholder-different
-- from the original 24 — orders snapshot product data so this is safe).
delete from products where id in (
  'everyday-shirt','tl-winter-hoodie','tl-winter-sweatpants','ttm-quarter-zip',
  'compression-shorts-2in1','embroidery-hoodie','embroidery-tee','autumn-hoodie',
  'boxe-tee','cargo-sweatpants','drawstring-long-sleeve','scrunch-leggings',
  'irregular-bra','basketball-shorts','gym-shirt','runner-vest','running-pants',
  'open-back-top','oversized-sweater','quarter-zip-long-sleeve','quick-dry-shirt',
  'slim-sweatshirt','slim-fit-pants','sport-pants','sport-pants-light',
  'tl-rocket-hoodie','tl-rocket-shirt','womens-2in1-shorts','womens-gym-shorts',
  'womens-sport-bra','vback-leggings','womens-hoodie','buttersoft-leggings'
);

insert into products (id, name, color, price_cents, category, tag, stock, description, image_url) values
  ('ascend-hoodie',     'TL Winter Hoodie',                     null,    4500, 'Outerwear', 'Featured', 50, 'Heavyweight winter pullover with the TL signature.', 'https://taglineapparel.myshopify.com/cdn/shop/files/rn-image_picker_lib_temp_8db61751-179f-4792-94db-fa33145c04eb.jpg?v=1768915828&width=1000'),
  ('halo-zip',          'TTM Quarter-Zip',                      null,    3500, 'Tops',      null,       40, 'Quarter-zip pullover with the TTM detail. Athletic cut, brushed inside.', 'https://taglineapparel.myshopify.com/cdn/shop/files/B2796E1A-0A02-4370-BC1A-87BDFE471E5A.png?v=1762482462&width=1000'),
  ('origin-tee',        '"Everyday" Shirt',                     null,    2500, 'Tops',      null,      100, 'The shirt you grab without thinking. Soft cotton, classic fit.', 'https://taglineapparel.myshopify.com/cdn/shop/files/rn-image_picker_lib_temp_8c64d9c2-9284-4019-b2f5-cb4ef82f3df6.png?v=1768914448&width=1000'),
  ('sigil-tank',        'Gym Shirt',                            null,    2500, 'Tops',      null,       80, 'Lightweight performance shirt with mesh-back panel. Built to move.', 'https://taglineapparel.myshopify.com/cdn/shop/files/rn-image_picker_lib_temp_65a0576e-dbba-443f-a04a-5d91f6d91d20.jpg?v=1775552279&width=1000'),
  ('vesper-long',       'Drawstring Long Sleeve',               null,    2500, 'Tops',      null,       60, 'Long sleeve tee with adjustable drawstring hem.', 'https://taglineapparel.myshopify.com/cdn/shop/files/4898461D-4ABC-445E-92D5-6D19078CD198.jpg?v=1761724512&width=1000'),
  ('path-jogger',       'TL Winter Pants',                      null,    5500, 'Bottoms',   'Featured', 45, 'Heavyweight winter pant with the TL signature. Brushed inside, tapered fit.', 'https://taglineapparel.myshopify.com/cdn/shop/files/rn-image_picker_lib_temp_7c4f5b99-50af-43eb-ac4e-81ff780a2b4b.jpg?v=1768725457&width=1000'),
  ('trial-short',       '2-in-1 Compression Shorts',            null,    4000, 'Bottoms',   null,       70, 'Compression liner inside, training short outside.', 'https://taglineapparel.myshopify.com/cdn/shop/files/IMG-0022.jpg?v=1761716083&width=1000'),
  ('cloud-crew',        'Slim Sweatshirt',                      null,    5000, 'Outerwear', null,       50, 'Slim-cut crewneck sweatshirt. Tailored shoulder, ribbed cuffs.', 'https://taglineapparel.myshopify.com/cdn/shop/files/IMG-0038.jpg?v=1761716083&width=1000'),
  ('crown-cap',         'TL "Rocket" Shirt',                    null,    2500, 'Tops',      null,       70, 'The Rocket tee. Soft, structured, statement-piece embroidery.', 'https://taglineapparel.myshopify.com/cdn/shop/files/rn-image_picker_lib_temp_95ca150e-60c6-4308-90f2-6310c8096b6a.jpg?v=1768722286&width=1000'),
  ('halo-runner',       'TL "Rocket" Hoodie',                   null,    5500, 'Outerwear', null,       30, 'The Rocket hoodie. Heavyweight, embroidered, unmistakably ours.', 'https://taglineapparel.myshopify.com/cdn/shop/files/rn-image_picker_lib_temp_b5276775-498d-4315-8251-37c7234be6b4.jpg?v=1768722983&width=1000'),
  ('aether-bra',        'Irregular Bra',                        null,    2500, 'Tops',      null,       60, 'Asymmetric strap design with light support and removable pads.', 'https://taglineapparel.myshopify.com/cdn/shop/files/B723BBA2-B00A-4C9A-8283-226AFEB8C698.jpg?v=1761548691&width=1000'),
  ('aether-legging',    'High-Waist Scrunch Leggings',          null,    2500, 'Bottoms',   null,       75, 'High-rise scrunch-back leggings with four-way stretch.', 'https://taglineapparel.myshopify.com/cdn/shop/files/10E1634C-49D7-4DD4-807E-47C10E802785.jpg?v=1762342748&width=1000'),
  ('reign-bomber',      '3-D Embroidery Hoodie',                null,    4500, 'Outerwear', null,       35, 'Heavyweight hoodie with raised 3-D embroidery. Premium feel.', 'https://taglineapparel.myshopify.com/cdn/shop/files/rn-image_picker_lib_temp_4981aa0e-9864-43bd-9e9e-c30e28e472b3.jpg?v=1775531157&width=1000'),
  ('velocity-track',    'Runner Vest',                          null,    4500, 'Outerwear', null,       30, 'Lightweight running vest with hi-vis trim.', 'https://taglineapparel.myshopify.com/cdn/shop/files/rn-image_picker_lib_temp_0a5e02aa-8e81-4e92-963d-cee6741b086c.jpg?v=1775536851&width=1000'),
  ('vow-beanie',        'Box''e Tee',                           null,    2000, 'Tops',      null,       90, 'Boxy-cut tee in heavyweight cotton. Loose, slightly cropped.', 'https://taglineapparel.myshopify.com/cdn/shop/files/rn-image_picker_lib_temp_935aa918-1d27-4cb2-96fb-e191e14f38f3.jpg?v=1775552279&width=1000'),
  ('anthem-polo',       'Quarter-Zip Long Sleeve',              null,    3500, 'Tops',      null,       45, 'Quarter-zip long sleeve in soft jersey. Layer-friendly.', 'https://taglineapparel.myshopify.com/cdn/shop/files/IMG-0025.jpg?v=1761716083&width=1000'),
  ('lumen-crop',        'Open-Back Top',                        null,    1500, 'Tops',      null,       65, 'Strappy open-back top for studio workouts. Light support, ample airflow.', 'https://taglineapparel.myshopify.com/cdn/shop/files/12F0C544-CB97-40D1-88BC-116B7BEBE75E.jpg?v=1762498096&width=1000'),
  ('pilgrim-pant',      'Sport Pants',                          null,    5500, 'Bottoms',   null,       30, 'Premium sport pant with side stripes. Tapered fit, drawcord waist.', 'https://taglineapparel.myshopify.com/cdn/shop/files/BD848E54-21F0-4255-B1F1-7D0A533C1E35.jpg?v=1761554034&width=1000'),
  ('spirit-shell',      'Autumn Hoodie',                        null,    4000, 'Outerwear', null,       45, 'Mid-weight pullover for transitional weather. Soft inside, structured outside.', 'https://taglineapparel.myshopify.com/cdn/shop/files/F927811C-A783-41CF-8491-3BB00D16D998.jpg?v=1762497681&width=1000'),
  ('echo-vest',         'Oversized Light Sweater',              null,    6500, 'Outerwear', null,       25, 'Soft-weave oversized sweater. Drapes long, layers easy.', 'https://taglineapparel.myshopify.com/cdn/shop/files/F329367F-4612-4CBE-A66D-A7BD3BC84DC1.jpg?v=1761553089&width=1000'),
  ('verse-henley',      'Quick-Dry Shirt',                      null,    2000, 'Tops',      null,       80, 'Performance shirt that dries in minutes. Anti-odor finish.', 'https://taglineapparel.myshopify.com/cdn/shop/files/7E62E8C7-9832-4D8F-B46A-AE8249EDD544.jpg?v=1761546662&width=1000'),
  ('sole-sock',         'Women''s Gym Shorts',                  null,    2000, 'Bottoms',   null,       80, 'Light, breathable gym shorts with built-in liner.', 'https://taglineapparel.myshopify.com/cdn/shop/files/rn-image_picker_lib_temp_1210f229-9c09-47f0-9203-2aa876bb70fb.jpg?v=1775552279&width=1000'),
  ('pulse-band',        'Women''s Sport Bra',                   null,    3000, 'Tops',      null,       60, 'Medium-support sport bra. Removable pads, racerback design.', 'https://taglineapparel.myshopify.com/cdn/shop/files/rn-image_picker_lib_temp_70148a65-ac5c-4e67-b9c8-10d2ad789c1c.jpg?v=1775552279&width=1000'),
  ('quill-tote',        'Women''s "Butter-Soft" Leggings',      null,    3000, 'Bottoms',   null,       70, 'Butter-soft fabric, high rise, pocket-equipped.', 'https://taglineapparel.myshopify.com/cdn/shop/files/AEEB6281-985A-423A-AAA8-097D87601F6D.jpg?v=1762231785&width=1000')
on conflict (id) do update set
  name        = excluded.name,
  color       = excluded.color,
  price_cents = excluded.price_cents,
  category    = excluded.category,
  tag         = excluded.tag,
  stock       = excluded.stock,
  description = excluded.description,
  image_url   = excluded.image_url,
  active      = true,
  updated_at  = now();
