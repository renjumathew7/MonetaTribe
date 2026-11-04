-- Run this once in Supabase SQL Editor to enable Family profiles.
-- Family budget rows remain in the existing monthly_budgets/envelopes/transactions tables.

create table if not exists public.families (
    id uuid primary key default gen_random_uuid(),
    name text not null check (length(trim(name)) between 1 and 80),
    invite_code text not null unique check (invite_code ~ '^[0-9]{6}$'),
    created_by uuid not null references auth.users(id) on delete cascade,
    created_at timestamptz not null default now()
);

create table if not exists public.family_members (
    family_id uuid not null references public.families(id) on delete cascade,
    user_id uuid not null unique references auth.users(id) on delete cascade,
    joined_at timestamptz not null default now(),
    primary key (family_id, user_id)
);

alter table public.monthly_budgets add column if not exists family_id uuid references public.families(id) on delete cascade;
-- The original user/start-date constraint makes a user's personal and family
-- budget collide when both periods start on the same date. Scope each kind separately.
alter table public.monthly_budgets drop constraint if exists monthly_budgets_user_id_start_date_key;
create unique index if not exists monthly_budgets_personal_user_start_key
    on public.monthly_budgets(user_id, start_date) where family_id is null;
create unique index if not exists monthly_budgets_family_start_key
    on public.monthly_budgets(family_id, start_date) where family_id is not null;
create index if not exists monthly_budgets_family_period_idx on public.monthly_budgets(family_id, start_date desc);

alter table public.families enable row level security;
alter table public.family_members enable row level security;
grant select on public.families, public.family_members to authenticated;

drop policy if exists "Family members can view their membership" on public.family_members;
create policy "Family members can view their membership" on public.family_members
    for select to authenticated using (user_id = auth.uid());

drop policy if exists "Family members can view their family" on public.families;
create policy "Family members can view their family" on public.families
    for select to authenticated using (
        exists (select 1 from public.family_members fm where fm.family_id = families.id and fm.user_id = auth.uid())
    );

create or replace function public.create_family(family_name_input text)
returns table(family_id uuid, family_name text, invite_code text)
language plpgsql security definer set search_path = public, auth
as $$
declare
    v_family_id uuid;
    v_code text;
    v_name text := trim(family_name_input);
begin
    if auth.uid() is null then raise exception 'Sign in to create a family.'; end if;
    if length(v_name) < 1 or length(v_name) > 80 then raise exception 'Family name must be between 1 and 80 characters.'; end if;
    if exists (select 1 from public.family_members fm where fm.user_id = auth.uid()) then
        raise exception 'Your account already belongs to a family.';
    end if;
    loop
        v_code := lpad(floor(random() * 1000000)::bigint::text, 6, '0');
        insert into public.families(name, invite_code, created_by)
        values (v_name, v_code, auth.uid())
        on conflict on constraint families_invite_code_key do nothing
        returning id into v_family_id;
        exit when v_family_id is not null;
    end loop;
    insert into public.family_members(family_id, user_id) values (v_family_id, auth.uid());
    return query select f.id, f.name, f.invite_code from public.families f where f.id = v_family_id;
end;
$$;

create or replace function public.join_family(invite_code_input text)
returns table(family_id uuid, family_name text, invite_code text)
language plpgsql security definer set search_path = public, auth
as $$
declare
    v_family public.families%rowtype;
begin
    if auth.uid() is null then raise exception 'Sign in to join a family.'; end if;
    if exists (select 1 from public.family_members fm where fm.user_id = auth.uid()) then
        raise exception 'Your account already belongs to a family.';
    end if;
    select f.* into v_family from public.families f where f.invite_code = trim(invite_code_input);
    if v_family.id is null then raise exception 'No family was found with that code.'; end if;
    insert into public.family_members(family_id, user_id) values (v_family.id, auth.uid());
    return query select v_family.id, v_family.name, v_family.invite_code;
end;
$$;

revoke all on function public.create_family(text) from public;
revoke all on function public.join_family(text) from public;
grant execute on function public.create_family(text) to authenticated;
grant execute on function public.join_family(text) to authenticated;

-- These permissive policies add family access alongside the app's existing owner policies.
drop policy if exists "Family members can access shared budgets" on public.monthly_budgets;
create policy "Family members can access shared budgets" on public.monthly_budgets
    for all to authenticated
    using (family_id is not null and exists (
        select 1 from public.family_members fm where fm.family_id = monthly_budgets.family_id and fm.user_id = auth.uid()
    ))
    with check (family_id is not null and exists (
        select 1 from public.family_members fm where fm.family_id = monthly_budgets.family_id and fm.user_id = auth.uid()
    ));

drop policy if exists "Family members can access shared envelopes" on public.envelopes;
create policy "Family members can access shared envelopes" on public.envelopes
    for all to authenticated
    using (exists (
        select 1 from public.monthly_budgets b join public.family_members fm on fm.family_id = b.family_id
        where b.id = envelopes.budget_id and fm.user_id = auth.uid()
    ))
    with check (exists (
        select 1 from public.monthly_budgets b join public.family_members fm on fm.family_id = b.family_id
        where b.id = envelopes.budget_id and fm.user_id = auth.uid()
    ));

drop policy if exists "Family members can access shared transactions" on public.transactions;
create policy "Family members can access shared transactions" on public.transactions
    for all to authenticated
    using (exists (
        select 1 from public.monthly_budgets b join public.family_members fm on fm.family_id = b.family_id
        where b.id = transactions.budget_id and fm.user_id = auth.uid()
    ))
    with check (exists (
        select 1 from public.monthly_budgets b join public.family_members fm on fm.family_id = b.family_id
        where b.id = transactions.budget_id and fm.user_id = auth.uid()
    ));
