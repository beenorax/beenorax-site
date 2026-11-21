-- Beenorax registration and role-based access setup
-- Run this script in Supabase SQL Editor before enabling registration.

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null default '',
  organization text not null default '',
  requested_role text not null default 'general_user'
    check (requested_role in ('researcher','student','business_analyst','general_user')),
  role text not null default 'general_user'
    check (role in ('admin','researcher','student','business_analyst','general_user')),
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

create or replace function public.create_beenorax_profile()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  requested text;
begin
  requested := coalesce(new.raw_user_meta_data->>'requested_role', 'general_user');
  if requested not in ('researcher','student','business_analyst','general_user') then
    requested := 'general_user';
  end if;
  insert into public.profiles (id, full_name, organization, requested_role, role)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'full_name', ''),
    coalesce(new.raw_user_meta_data->>'organization', ''),
    requested,
    'general_user'
  ) on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created_beenorax on auth.users;
create trigger on_auth_user_created_beenorax
after insert on auth.users
for each row execute procedure public.create_beenorax_profile();

create or replace function public.beenorax_is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'admin'
  );
$$;

grant usage on schema public to authenticated;
grant select on public.profiles to authenticated;

-- Users may read only their own profile. Admin management is performed
-- through the protected Netlify function using the server-only service key.
drop policy if exists "Users can read own profile" on public.profiles;
create policy "Users can read own profile"
on public.profiles for select
to authenticated
using (id = auth.uid() or public.beenorax_is_admin());

-- Deliberately no client INSERT, UPDATE, or DELETE policies. This prevents
-- users from promoting themselves or changing their account role.

-- ============================================================
-- Beenorax shared publishing platform: BJBS and BJBA
-- Run this complete file once in the Supabase SQL Editor.
-- ============================================================

create table if not exists public.journal_memberships (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  journal_code text not null check (journal_code in ('bjbs','bjba')),
  role text not null check (role in ('editor_in_chief','associate_editor','journal_admin','reviewer')),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (user_id, journal_code, role)
);

create table if not exists public.journal_submissions (
  id uuid primary key default gen_random_uuid(),
  reference_code text not null unique,
  journal_code text not null check (journal_code in ('bjbs','bjba')),
  author_id uuid not null references auth.users(id) on delete restrict,
  title text not null check (char_length(title) between 8 and 300),
  authors_text text not null,
  abstract text not null check (char_length(abstract) between 30 and 5000),
  keywords text[] not null default '{}',
  file_path text not null,
  file_name text not null,
  status text not null default 'submitted' check (status in ('submitted','editorial_screening','under_review','revision','accepted','rejected','published','withdrawn')),
  submitted_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists journal_submissions_author_idx on public.journal_submissions(author_id, submitted_at desc);
create index if not exists journal_submissions_journal_status_idx on public.journal_submissions(journal_code, status, submitted_at);

create table if not exists public.journal_reviewer_assignments (
  id uuid primary key default gen_random_uuid(),
  submission_id uuid not null references public.journal_submissions(id) on delete cascade,
  reviewer_id uuid not null references auth.users(id) on delete restrict,
  status text not null default 'invited' check (status in ('invited','accepted','declined','completed')),
  created_at timestamptz not null default now(),
  unique (submission_id, reviewer_id)
);
create index if not exists journal_reviewer_assignments_reviewer_idx on public.journal_reviewer_assignments(reviewer_id, created_at desc);

create table if not exists public.journal_reviews (
  id uuid primary key default gen_random_uuid(),
  assignment_id uuid not null unique references public.journal_reviewer_assignments(id) on delete cascade,
  recommendation text not null check (recommendation in ('accept','minor_revision','major_revision','reject')),
  author_comments text not null default '',
  confidential_comments text not null default '',
  submitted_at timestamptz not null default now()
);

create table if not exists public.journal_editorial_decisions (
  id uuid primary key default gen_random_uuid(),
  submission_id uuid not null references public.journal_submissions(id) on delete cascade,
  editor_id uuid not null references auth.users(id) on delete restrict,
  decision text not null check (decision in ('editorial_screening','under_review','revision','accepted','rejected')),
  decision_note text not null default '',
  created_at timestamptz not null default now()
);

create table if not exists public.journal_articles (
  id uuid primary key default gen_random_uuid(),
  submission_id uuid not null unique references public.journal_submissions(id) on delete restrict,
  journal_code text not null check (journal_code in ('bjbs','bjba')),
  title text not null,
  authors text[] not null default '{}',
  abstract text not null default '',
  keywords text[] not null default '{}',
  doi text,
  article_url text,
  status text not null default 'published' check (status in ('published','corrected','retracted')),
  published_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index if not exists journal_articles_publication_idx on public.journal_articles(journal_code, status, published_at desc);

alter table public.journal_memberships enable row level security;
alter table public.journal_submissions enable row level security;
alter table public.journal_reviewer_assignments enable row level security;
alter table public.journal_reviews enable row level security;
alter table public.journal_editorial_decisions enable row level security;
alter table public.journal_articles enable row level security;

-- Publishing operations use the server-side service role. Public visitors
-- can read published article metadata only. Manuscript files stay private.
drop policy if exists "Anyone can read published journal articles" on public.journal_articles;
create policy "Anyone can read published journal articles"
on public.journal_articles for select to anon, authenticated
using (status in ('published','corrected','retracted'));

grant select on public.journal_articles to anon, authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('journal-manuscripts','journal-manuscripts',false,20971520,
  array['application/pdf','application/vnd.openxmlformats-officedocument.wordprocessingml.document'])
on conflict (id) do update set public=false, file_size_limit=20971520,
  allowed_mime_types=excluded.allowed_mime_types;

drop policy if exists "Authors upload manuscripts to own folder" on storage.objects;
create policy "Authors upload manuscripts to own folder"
on storage.objects for insert to authenticated
with check (bucket_id='journal-manuscripts' and (storage.foldername(name))[1]=auth.uid()::text);

drop policy if exists "Authors can view own manuscript files" on storage.objects;
create policy "Authors can view own manuscript files"
on storage.objects for select to authenticated
using (bucket_id='journal-manuscripts' and (storage.foldername(name))[1]=auth.uid()::text);
