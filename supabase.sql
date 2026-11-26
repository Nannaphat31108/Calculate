-- ระบบบัญชีด้วยชื่อผู้ใช้ + รหัสผ่าน (ไม่ใช้อีเมล) และประวัติรายการเสนอขายของแต่ละบัญชี
-- วิธีใช้: Supabase > SQL Editor > New query > วางทั้งไฟล์ > Run (รันซ้ำได้ ไม่ลบข้อมูลเดิม)

create extension if not exists pgcrypto with schema extensions;

-- บัญชีผู้ใช้: เก็บรหัสผ่านแบบเข้ารหัส (bcrypt) ไม่เก็บตัวจริง
create table if not exists public.app_users (
  username_key text primary key,            -- ชื่อผู้ใช้แบบตัวเล็ก ใช้กันชื่อซ้ำ
  username text not null,                   -- ชื่อผู้ใช้ตามที่พิมพ์
  pass_hash text not null,
  created_at timestamptz not null default now()
);

-- การเข้าสู่ระบบแต่ละเครื่อง
create table if not exists public.app_sessions (
  token text primary key,
  username_key text not null references public.app_users (username_key) on delete cascade,
  created_at timestamptz not null default now(),
  last_used timestamptz not null default now()
);

-- ประวัติรายการเสนอขาย ผูกกับบัญชี
create table if not exists public.app_offers (
  username_key text not null references public.app_users (username_key) on delete cascade,
  id text not null,
  no integer not null,
  info jsonb not null default '{}'::jsonb,
  items jsonb not null default '[]'::jsonb,
  totals jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (username_key, id)
);

-- ปิดการเข้าถึงตารางโดยตรง ให้ใช้ผ่านฟังก์ชันด้านล่างเท่านั้น
alter table public.app_users enable row level security;
alter table public.app_sessions enable row level security;
alter table public.app_offers enable row level security;
revoke all on public.app_users, public.app_sessions, public.app_offers from anon, authenticated;

-- ---------- ฟังก์ชัน ----------
create or replace function public.app_new_session(p_key text) returns text
language plpgsql security definer set search_path = public, extensions as $$
declare t text := encode(gen_random_bytes(32), 'hex');
begin
  insert into app_sessions (token, username_key) values (t, p_key);
  return t;
end $$;

create or replace function public.app_session_user(p_token text) returns text
language plpgsql security definer set search_path = public, extensions as $$
declare k text;
begin
  update app_sessions set last_used = now()
   where token = p_token and last_used > now() - interval '180 days'
   returning username_key into k;
  if k is null then raise exception 'BAD_SESSION'; end if;
  return k;
end $$;

create or replace function public.app_signup(p_username text, p_password text) returns json
language plpgsql security definer set search_path = public, extensions as $$
declare u text := btrim(coalesce(p_username, '')); k text;
begin
  if char_length(u) < 1 or char_length(u) > 50 then raise exception 'BAD_USERNAME'; end if;
  if char_length(coalesce(p_password, '')) < 4 then raise exception 'SHORT_PASSWORD'; end if;
  k := lower(u);
  if exists (select 1 from app_users where username_key = k) then raise exception 'USERNAME_TAKEN'; end if;
  insert into app_users (username_key, username, pass_hash) values (k, u, crypt(p_password, gen_salt('bf')));
  return json_build_object('token', app_new_session(k), 'username', u);
end $$;

create or replace function public.app_login(p_username text, p_password text) returns json
language plpgsql security definer set search_path = public, extensions as $$
declare r app_users;
begin
  select * into r from app_users where username_key = lower(btrim(coalesce(p_username, '')));
  if r is null or r.pass_hash <> crypt(coalesce(p_password, ''), r.pass_hash) then
    perform pg_sleep(0.5);
    raise exception 'BAD_LOGIN';
  end if;
  return json_build_object('token', app_new_session(r.username_key), 'username', r.username);
end $$;

create or replace function public.app_logout(p_token text) returns void
language sql security definer set search_path = public as $$
  delete from app_sessions where token = p_token;
$$;

create or replace function public.app_me(p_token text) returns json
language plpgsql security definer set search_path = public, extensions as $$
declare k text := app_session_user(p_token);
begin
  return json_build_object('username', (select username from app_users where username_key = k));
end $$;

create or replace function public.app_list_offers(p_token text) returns json
language plpgsql security definer set search_path = public, extensions as $$
declare k text := app_session_user(p_token);
begin
  return coalesce((
    select json_agg(json_build_object('id', id, 'no', no, 'info', info, 'items', items, 'totals', totals,
                                      'created_at', created_at, 'updated_at', updated_at) order by no desc)
      from app_offers where username_key = k), '[]'::json);
end $$;

create or replace function public.app_put_offers(p_token text, p_rows jsonb) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare k text := app_session_user(p_token); r jsonb;
begin
  for r in select * from jsonb_array_elements(p_rows) loop
    insert into app_offers (username_key, id, no, info, items, totals, created_at, updated_at)
    values (k, r->>'id', (r->>'no')::int, coalesce(r->'info', '{}'), coalesce(r->'items', '[]'), coalesce(r->'totals', '{}'),
            coalesce((r->>'created_at')::timestamptz, now()), coalesce((r->>'updated_at')::timestamptz, now()))
    on conflict (username_key, id) do update
      set no = excluded.no, info = excluded.info, items = excluded.items,
          totals = excluded.totals, updated_at = excluded.updated_at;
  end loop;
end $$;

create or replace function public.app_delete_offer(p_token text, p_id text) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare k text := app_session_user(p_token);
begin
  delete from app_offers where username_key = k and id = p_id;
end $$;

-- ให้หน้าเว็บเรียกได้เฉพาะฟังก์ชันหลัก (ฟังก์ชันภายในเรียกจากหน้าเว็บไม่ได้)
revoke all on function public.app_new_session(text), public.app_session_user(text) from public, anon, authenticated;
revoke all on function public.app_signup(text, text), public.app_login(text, text), public.app_logout(text),
  public.app_me(text), public.app_list_offers(text), public.app_put_offers(text, jsonb), public.app_delete_offer(text, text) from public;
grant execute on function public.app_signup(text, text), public.app_login(text, text), public.app_logout(text),
  public.app_me(text), public.app_list_offers(text), public.app_put_offers(text, jsonb), public.app_delete_offer(text, text)
  to anon, authenticated;

-- ให้ Supabase รู้จักฟังก์ชันใหม่ทันที
notify pgrst, 'reload schema';
