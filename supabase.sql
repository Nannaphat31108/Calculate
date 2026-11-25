-- ตารางเก็บประวัติรายการเสนอขาย (รันครั้งเดียวใน Supabase > SQL Editor)
create table if not exists public.offers (
  id text primary key,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  no integer not null,
  info jsonb not null default '{}'::jsonb,
  items jsonb not null default '[]'::jsonb,
  totals jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists offers_user_no_idx on public.offers (user_id, no desc);

-- ให้แต่ละบัญชีเห็นและแก้ได้เฉพาะข้อมูลของตัวเอง
alter table public.offers enable row level security;

drop policy if exists "own offers" on public.offers;
create policy "own offers" on public.offers
  for all to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
