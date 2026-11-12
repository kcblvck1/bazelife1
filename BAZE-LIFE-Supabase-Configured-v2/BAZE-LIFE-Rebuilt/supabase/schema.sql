
-- BAZE LIFE: SAFE SUPABASE DATABASE SETUP

-- 1. PROFILES TABLE
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text unique not null check (char_length(username) between 3 and 18),
  display_name text not null check (char_length(display_name) between 1 and 28),
  gender text not null check (gender in ('male','female')),
  location text not null default 'Campus',
  last_seen timestamptz not null default now(),
  created_at timestamptz not null default now()
);

-- 2. CAMPUS MESSAGES TABLE
create table if not exists public.messages (
  id bigint generated always as identity primary key,
  sender_id uuid not null references public.profiles(id) on delete cascade,
  sender_username text not null,
  body text not null check (char_length(body) between 1 and 500),
  created_at timestamptz not null default now()
);

-- 3. ENABLE ROW LEVEL SECURITY
alter table public.profiles enable row level security;
alter table public.messages enable row level security;

-- 4. REMOVE OLD POLICIES BEFORE RECREATING
drop policy if exists "Profiles are visible to signed-in students" on public.profiles;
drop policy if exists "Students can create their own profile" on public.profiles;
drop policy if exists "Students can update their own profile" on public.profiles;
drop policy if exists "Signed-in students can read campus chat" on public.messages;
drop policy if exists "Students can send as themselves" on public.messages;

-- 5. PROFILE SECURITY POLICIES
create policy "Profiles are visible to signed-in students"
on public.profiles
for select to authenticated
using (true);

create policy "Students can create their own profile"
on public.profiles
for insert to authenticated
with check (auth.uid() = id);

create policy "Students can update their own profile"
on public.profiles
for update to authenticated
using (auth.uid() = id)
with check (auth.uid() = id);

-- 6. CHAT SECURITY POLICIES
create policy "Signed-in students can read campus chat"
on public.messages
for select to authenticated
using (true);

create policy "Students can send as themselves"
on public.messages
for insert to authenticated
with check (
  auth.uid() = sender_id
  and sender_username = (
    select username
    from public.profiles
    where id = auth.uid()
  )
  and char_length(body) between 1 and 500
);

-- 7. DATABASE PERMISSIONS
grant select, insert, update on public.profiles to authenticated;
grant select, insert on public.messages to authenticated;
grant usage, select on sequence public.messages_id_seq to authenticated;

-- 8. ENABLE REALTIME FOR CAMPUS CHAT
do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
    and schemaname = 'public'
    and tablename = 'messages'
  ) then
    alter publication supabase_realtime add table public.messages;
  end if;
end;
$$;

-- 9. AUTOMATIC STUDENT PROFILE CREATION
create or replace function public.handle_new_student_profile()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (
    id, username, display_name, gender, location
  )
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'username', split_part(new.email, '@', 1)),
    coalesce(new.raw_user_meta_data->>'name', 'Student'),
    case
      when new.raw_user_meta_data->>'gender' = 'female'
      then 'female'
      else 'male'
    end,
    case
      when new.raw_user_meta_data->>'gender' = 'female'
      then 'Female Hostel'
      else 'Male Hostel'
    end
  )
  on conflict (id) do nothing;

  return new;
end;
$$;

-- 10. RECREATE AUTH TRIGGER
drop trigger if exists on_auth_student_created on auth.users;

create trigger on_auth_student_created
after insert on auth.users
for each row
execute procedure public.handle_new_student_profile();
