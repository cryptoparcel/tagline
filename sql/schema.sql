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
  tag text, -- 'New', 'Limited', 'Restock', 'Sold Out', 'Featured', null
  stock integer not null default 0,
  active boolean not null default true,
  stripe_price_id text, -- filled in once you create products in Stripe
  description text,
  image_url text, -- public image URL (Shopify CDN or self-hosted). Falls back to /images/products/{id}.jpg if null.
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
-- SEED DATA — Real Tagline Apparel catalog (33 products)
-- ============================================================
-- Image URLs point at the Shopify CDN with width=1000 for sharp retina
-- rendering. Note: 'tl-winter-sweatpants' uses a .heic file — most
-- browsers can't display it; the letter-placeholder fallback shows
-- until you re-upload as JPG/PNG. Items 'open-back-top' and
-- 'vback-leggings' point at the same image — fix one of them when you
-- have a unique photo.

-- Clean up the old placeholder catalog (the 24 ascend-hoodie/halo-zip/etc.
-- products) on existing deployments. Safe to re-run — does nothing if
-- they're already gone. Keeps any orders that referenced them untouched
-- (orders.items is a JSON snapshot, not a foreign key).
delete from products where id in (
  'ascend-hoodie','halo-zip','origin-tee','sigil-tank','vesper-long',
  'path-jogger','trial-short','cloud-crew','crown-cap','halo-runner',
  'aether-bra','aether-legging','reign-bomber','velocity-track','vow-beanie',
  'anthem-polo','lumen-crop','pilgrim-pant','spirit-shell','echo-vest',
  'verse-henley','sole-sock','pulse-band','quill-tote'
);

insert into products (id, name, color, price_cents, category, tag, stock, description, image_url) values
  ('everyday-shirt',           '"Everyday" Shirt',                 null,    2500, 'Tops',        null,       60, 'The shirt you grab without thinking. Soft cotton, classic fit, made for daily rotation.', 'https://taglineapparel.myshopify.com/cdn/shop/files/rn-image_picker_lib_temp_8c64d9c2-9284-4019-b2f5-cb4ef82f3df6.png?v=1768914448&width=1000'),
  ('tl-winter-hoodie',         '"TL" Winter Hoodie',               null,    4500, 'Outerwear',   null,       50, 'Heavyweight winter pullover with the TL signature. Built for cold mornings and casual nights.', 'https://taglineapparel.myshopify.com/cdn/shop/files/rn-image_picker_lib_temp_8db61751-179f-4792-94db-fa33145c04eb.jpg?v=1768915828&width=1000'),
  ('tl-winter-sweatpants',     '"TL" Winter Sweatpants',           null,    4500, 'Bottoms',     null,       45, 'Match the hoodie. Heavy fleece-lined sweatpants with side pockets and an embroidered logo.', 'https://taglineapparel.myshopify.com/cdn/shop/files/rn-image_picker_lib_temp_e2a10b3a-eb39-4d5d-b226-97c26277a75b.heic?v=1768915828&width=1000'),
  ('ttm-quarter-zip',          '"TTM" Quarter-Zip',                null,    3500, 'Tops',        null,       40, 'Quarter-zip pullover with the TTM detail. Athletic cut, brushed inside, pairs with anything.', 'https://taglineapparel.myshopify.com/cdn/shop/files/B2796E1A-0A02-4370-BC1A-87BDFE471E5A.png?v=1762482462&width=1000'),
  ('compression-shorts-2in1',  '2-in-1 Compression Shorts',        null,    4000, 'Bottoms',     null,       60, 'Compression liner inside, training short outside. The pair that handles the gym AND the run.', 'https://taglineapparel.myshopify.com/cdn/shop/files/IMG-0022.jpg?v=1761716083&width=1000'),
  ('embroidery-hoodie',        '3-D Embroidery Hoodie',            null,    4500, 'Outerwear',   null,       35, 'Heavyweight hoodie with raised 3-D embroidery. Premium feel, statement detail.', 'https://taglineapparel.myshopify.com/cdn/shop/files/rn-image_picker_lib_temp_4981aa0e-9864-43bd-9e9e-c30e28e472b3.jpg?v=1775531157&width=1000'),
  ('embroidery-tee',           '3-D Embroidery T-Shirt',           null,    3000, 'Tops',        null,       80, 'Premium tee with raised 3-D embroidery. Heavy enough to drape right, soft enough to live in.', 'https://taglineapparel.myshopify.com/cdn/shop/files/rn-image_picker_lib_temp_caac77bf-a368-4c9f-8dba-f96b475ed42c.jpg?v=1775534730&width=1000'),
  ('autumn-hoodie',            'Autumn Hoodie',                    null,    4000, 'Outerwear',   null,       45, 'Mid-weight pullover for transitional weather. Soft inside, structured outside.', 'https://taglineapparel.myshopify.com/cdn/shop/files/F927811C-A783-41CF-8491-3BB00D16D998.jpg?v=1762497681&width=1000'),
  ('boxe-tee',                 'Box''e Tee',                       null,    2000, 'Tops',        null,       90, 'Boxy-cut tee in heavyweight cotton. Loose through the chest and shoulders, slightly cropped.', 'https://taglineapparel.myshopify.com/cdn/shop/files/rn-image_picker_lib_temp_935aa918-1d27-4cb2-96fb-e191e14f38f3.jpg?v=1775552279&width=1000'),
  ('cargo-sweatpants',         'Cargo Sweatpants',                 null,    5500, 'Bottoms',     null,       35, 'Sweatpants meet cargo pockets. Tapered leg, drawcord waist, six functional pockets.', 'https://taglineapparel.myshopify.com/cdn/shop/files/rn-image_picker_lib_temp_7c4f5b99-50af-43eb-ac4e-81ff780a2b4b.jpg?v=1768725457&width=1000'),
  ('drawstring-long-sleeve',   'Drawstring Long Sleeve',           null,    2500, 'Tops',        null,       70, 'Long sleeve tee with adjustable drawstring hem. Layer it open or pull it tight.', 'https://taglineapparel.myshopify.com/cdn/shop/files/4898461D-4ABC-445E-92D5-6D19078CD198.jpg?v=1761724512&width=1000'),
  ('scrunch-leggings',         'High-Waist Scrunch Leggings',      null,    2500, 'Bottoms',     null,       75, 'High-rise scrunch-back leggings with four-way stretch. Lifts and supports.', 'https://taglineapparel.myshopify.com/cdn/shop/files/10E1634C-49D7-4DD4-807E-47C10E802785.jpg?v=1762342748&width=1000'),
  ('irregular-bra',            'Irregular Bra',                    null,    2500, 'Tops',        null,       60, 'Asymmetric strap design with light support and removable pads. Different on purpose.', 'https://taglineapparel.myshopify.com/cdn/shop/files/B723BBA2-B00A-4C9A-8283-226AFEB8C698.jpg?v=1761548691&width=1000'),
  ('basketball-shorts',        'Basketball Shorts',                null,    2500, 'Bottoms',     null,       80, 'Court-ready shorts with deep pockets. Mesh-lined for breathability, built to last.', 'https://taglineapparel.myshopify.com/cdn/shop/files/rn-image_picker_lib_temp_59c8766e-4591-468f-8075-8b4287f30a9f.jpg?v=1775535578&width=1000'),
  ('gym-shirt',                'Gym Shirt',                        null,    2500, 'Tops',        null,       70, 'Lightweight performance shirt with a mesh-back panel. Built to move, dries fast.', 'https://taglineapparel.myshopify.com/cdn/shop/files/rn-image_picker_lib_temp_65a0576e-dbba-443f-a04a-5d91f6d91d20.jpg?v=1775552279&width=1000'),
  ('runner-vest',              'Runner Vest',                      null,    4500, 'Outerwear',   null,       30, 'Lightweight running vest with hi-vis trim. Holds your essentials without the bounce.', 'https://taglineapparel.myshopify.com/cdn/shop/files/rn-image_picker_lib_temp_0a5e02aa-8e81-4e92-963d-cee6741b086c.jpg?v=1775536851&width=1000'),
  ('running-pants',            'Running Pants',                    null,    3000, 'Bottoms',     null,       50, 'Tapered running pants with reflective accents. Light, fast, weather-ready.', 'https://taglineapparel.myshopify.com/cdn/shop/files/rn-image_picker_lib_temp_570552c0-1a69-472d-9320-398747b35f08.jpg?v=1775536043&width=1000'),
  ('open-back-top',            'Open-Back Top',                    null,    1500, 'Tops',        null,       65, 'Strappy open-back top for studio workouts. Light support, ample airflow.', 'https://taglineapparel.myshopify.com/cdn/shop/files/12F0C544-CB97-40D1-88BC-116B7BEBE75E.jpg?v=1762498096&width=1000'),
  ('oversized-sweater',        'Oversized Light Sweater',          null,    6500, 'Outerwear',   null,       25, 'Soft-weave oversized sweater. Drapes long, layers easy, finishes any outfit.', 'https://taglineapparel.myshopify.com/cdn/shop/files/F329367F-4612-4CBE-A66D-A7BD3BC84DC1.jpg?v=1761553089&width=1000'),
  ('quarter-zip-long-sleeve',  'Quarter-Zip Long Sleeve',          null,    3500, 'Tops',        null,       45, 'Quarter-zip long sleeve in soft jersey. Layer-friendly, runs true to size.', 'https://taglineapparel.myshopify.com/cdn/shop/files/IMG-0025.jpg?v=1761716083&width=1000'),
  ('quick-dry-shirt',          'Quick-Dry Shirt',                  null,    2000, 'Tops',        null,       80, 'Performance shirt that dries in minutes. Anti-odor finish, low-profile fit.', 'https://taglineapparel.myshopify.com/cdn/shop/files/7E62E8C7-9832-4D8F-B46A-AE8249EDD544.jpg?v=1761546662&width=1000'),
  ('slim-sweatshirt',          'Slim Sweatshirt',                  null,    5000, 'Outerwear',   null,       35, 'Slim-cut crewneck sweatshirt. Tailored shoulder, ribbed cuffs, brushed inside.', 'https://taglineapparel.myshopify.com/cdn/shop/files/IMG-0038.jpg?v=1761716083&width=1000'),
  ('slim-fit-pants',           'Slim-Fit Flex Pants',              null,    3500, 'Bottoms',     null,       50, 'Slim-fit flex pants with stretch. Comfortable enough for shifts, sharp enough for off-duty.', 'https://taglineapparel.myshopify.com/cdn/shop/files/8C4F7825-DEEA-4CEF-955E-C5432C6FB34B.jpg?v=1761544634&width=1000'),
  ('sport-pants',              'Sport Pants',                      null,    5500, 'Bottoms',     null,       30, 'Premium sport pant with side stripes. Tapered fit, drawcord waist, finished hem.', 'https://taglineapparel.myshopify.com/cdn/shop/files/BD848E54-21F0-4255-B1F1-7D0A533C1E35.jpg?v=1761554034&width=1000'),
  ('sport-pants-light',        'Sport Pant Light',                 null,    3500, 'Bottoms',     null,       50, 'Lighter weight version of our sport pant. Same fit, less weight — for warmer months.', 'https://taglineapparel.myshopify.com/cdn/shop/files/ECE25F92-576E-4A30-B8F5-CCD44DB470B0.jpg?v=1761627349&width=1000'),
  ('tl-rocket-hoodie',         'TL "Rocket" Hoodie',               null,    5500, 'Outerwear',   'Featured', 30, 'The Rocket hoodie. Heavyweight, embroidered, and unmistakably ours.', 'https://taglineapparel.myshopify.com/cdn/shop/files/rn-image_picker_lib_temp_b5276775-498d-4315-8251-37c7234be6b4.jpg?v=1768722983&width=1000'),
  ('tl-rocket-shirt',          'TL "Rocket" Shirt',                null,    2500, 'Tops',        'Featured', 70, 'The Rocket tee. Soft, structured, statement-piece embroidery.', 'https://taglineapparel.myshopify.com/cdn/shop/files/rn-image_picker_lib_temp_95ca150e-60c6-4308-90f2-6310c8096b6a.jpg?v=1768722286&width=1000'),
  ('womens-2in1-shorts',       'Women''s 2-in-1 Shorts',           null,    3000, 'Bottoms',     null,       55, 'Compression liner under a flowy short. The pair that goes from gym to coffee.', 'https://taglineapparel.myshopify.com/cdn/shop/files/rn-image_picker_lib_temp_26e60b6f-49f2-4a3a-b34d-2140bfdf784e.jpg?v=1775536820&width=1000'),
  ('womens-gym-shorts',        'Women''s Gym Shorts',              null,    2000, 'Bottoms',     null,       80, 'Light, breathable gym shorts with built-in liner. Quick-drying, doesn''t ride.', 'https://taglineapparel.myshopify.com/cdn/shop/files/rn-image_picker_lib_temp_1210f229-9c09-47f0-9203-2aa876bb70fb.jpg?v=1775552279&width=1000'),
  ('womens-sport-bra',         'Women''s Sport Bra',               null,    3000, 'Tops',        null,       60, 'Medium-support sport bra. Removable pads, racerback design, moisture-wicking.', 'https://taglineapparel.myshopify.com/cdn/shop/files/rn-image_picker_lib_temp_70148a65-ac5c-4e67-b9c8-10d2ad789c1c.jpg?v=1775552279&width=1000'),
  ('vback-leggings',           'V-Back Leggings',                  null,    3000, 'Bottoms',     null,       65, 'High-waist V-back leggings. Sculpted seam, four-way stretch, opaque from every angle.', 'https://taglineapparel.myshopify.com/cdn/shop/files/12F0C544-CB97-40D1-88BC-116B7BEBE75E.jpg?v=1762498096&width=1000'),
  ('womens-hoodie',            'Women''s Hoodie',                  null,    3500, 'Outerwear',   null,       50, 'Cropped-fit pullover hoodie for women. Heavy cotton, fits true.', 'https://taglineapparel.myshopify.com/cdn/shop/files/A610FF16-6BA4-4255-90B0-F42AB7246271.jpg?v=1762317317&width=1000'),
  ('buttersoft-leggings',      'Women''s "Butter-Soft" Leggings',  null,    3000, 'Bottoms',     'New',      70, 'Butter-soft fabric, high rise, pocket-equipped. The leggings you''ll forget you''re wearing.', 'https://taglineapparel.myshopify.com/cdn/shop/files/AEEB6281-985A-423A-AAA8-097D87601F6D.jpg?v=1762231785&width=1000')
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
