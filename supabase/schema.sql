create table if not exists public.employee_profiles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  employee_id text not null unique,
  full_name text not null,
  face_model text,
  created_at timestamptz not null default now()
);

create table if not exists public.attendance_events (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  action text not null check (action in ('clock-in', 'clock-out')),
  timestamp timestamptz not null default now()
);

create index if not exists attendance_events_user_timestamp_idx
  on public.attendance_events (user_id, timestamp desc);

alter table public.employee_profiles enable row level security;
alter table public.attendance_events enable row level security;

grant select, insert, update on public.employee_profiles to authenticated;
grant select, insert on public.attendance_events to authenticated;
grant usage, select on sequence public.attendance_events_id_seq to authenticated;

drop policy if exists "Users can view their own profile" on public.employee_profiles;
create policy "Users can view their own profile"
  on public.employee_profiles for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "Users can create their own profile" on public.employee_profiles;
create policy "Users can create their own profile"
  on public.employee_profiles for insert to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists "Users can update their own profile" on public.employee_profiles;
create policy "Users can update their own profile"
  on public.employee_profiles for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "Users can view their own attendance" on public.attendance_events;
create policy "Users can view their own attendance"
  on public.attendance_events for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "Users can add their own attendance" on public.attendance_events;
create policy "Users can add their own attendance"
  on public.attendance_events for insert to authenticated
  with check ((select auth.uid()) = user_id);
