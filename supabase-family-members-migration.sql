-- Family member list, member restrictions, and Exit Family support.
-- Run after supabase-family-migration.sql. This changes policies/functions,
-- not budget, pocket, or transaction rows.

alter table public.family_members add column if not exists role text not null default 'member';
alter table public.family_members add column if not exists is_restricted boolean not null default false;

create or replace function public.is_family_member(p_family_id uuid)
returns boolean language sql stable security definer set search_path = public, auth
as $$
    select auth.uid() is not null and exists (
        select 1 from public.family_members fm
        where fm.family_id = p_family_id and fm.user_id = auth.uid()
    );
$$;

create or replace function public.is_family_admin(p_family_id uuid)
returns boolean language sql stable security definer set search_path = public, auth
as $$
    select auth.uid() is not null and exists (
        select 1
        from public.family_members fm
        join public.families f on f.id = fm.family_id
        where fm.family_id = p_family_id and fm.user_id = auth.uid()
          and (fm.role = 'admin' or f.created_by = auth.uid())
    );
$$;

create or replace function public.is_family_manager(p_family_id uuid)
returns boolean language sql stable security definer set search_path = public, auth
as $$
    select auth.uid() is not null and exists (
        select 1
        from public.family_members fm
        join public.families f on f.id = fm.family_id
        where fm.family_id = p_family_id and fm.user_id = auth.uid()
          and (fm.role = 'admin' or f.created_by = auth.uid() or not fm.is_restricted)
    );
$$;

create or replace function public.is_personal_budget(p_budget_id uuid)
returns boolean language sql stable security definer set search_path = public, auth
as $$
    select not exists (
        select 1 from public.monthly_budgets b
        where b.id = p_budget_id and b.family_id is not null
    );
$$;

create or replace function public.is_family_member_for_budget(p_budget_id uuid)
returns boolean language sql stable security definer set search_path = public, auth
as $$
    select exists (
        select 1 from public.monthly_budgets b
        where b.id = p_budget_id and b.family_id is not null
          and public.is_family_member(b.family_id)
    );
$$;

create or replace function public.is_family_manager_for_budget(p_budget_id uuid)
returns boolean language sql stable security definer set search_path = public, auth
as $$
    select exists (
        select 1 from public.monthly_budgets b
        where b.id = p_budget_id and b.family_id is not null
          and public.is_family_manager(b.family_id)
    );
$$;

create or replace function public.is_restricted_family_member_for_budget(p_budget_id uuid)
returns boolean language sql stable security definer set search_path = public, auth
as $$
    select exists (
        select 1
        from public.monthly_budgets b
        join public.family_members fm on fm.family_id = b.family_id
        where b.id = p_budget_id and b.family_id is not null
          and fm.user_id = auth.uid() and fm.is_restricted
          and not public.is_family_admin(b.family_id)
    );
$$;

drop function if exists public.get_family_members();
create function public.get_family_members()
returns table(member_user_id uuid, display_name text, joined_at timestamptz, role text, is_restricted boolean)
language sql stable security definer set search_path = public, auth
as $$
    select
        fm.user_id,
        coalesce(
            nullif(btrim(u.raw_user_meta_data ->> 'full_name'), ''),
            nullif(btrim(u.raw_user_meta_data ->> 'name'), ''),
            nullif(split_part(coalesce(u.email, ''), '@', 1), ''),
            'Family member'
        ),
        fm.joined_at,
        case when f.created_by = fm.user_id then 'admin' else fm.role end,
        fm.is_restricted
    from public.family_members fm
    join public.families f on f.id = fm.family_id
    join auth.users u on u.id = fm.user_id
    where auth.uid() is not null
      and fm.family_id = (
          select mine.family_id
          from public.family_members mine
          where mine.user_id = auth.uid()
          limit 1
      )
    order by case when f.created_by = fm.user_id then 0 else 1 end, fm.joined_at asc;
$$;

create or replace function public.set_family_member_restriction(target_user_id uuid, restrict_member boolean)
returns boolean
language plpgsql security definer set search_path = public, auth
as $$
declare
    v_family_id uuid;
begin
    if auth.uid() is null then raise exception 'Sign in to manage family access.'; end if;
    select fm.family_id into v_family_id
    from public.family_members fm where fm.user_id = auth.uid();
    if v_family_id is null or not public.is_family_admin(v_family_id) then
        raise exception 'Only the Family Admin can change member access.';
    end if;
    update public.family_members fm
    set is_restricted = restrict_member
    from public.families f
    where f.id = fm.family_id
      and fm.family_id = v_family_id
      and fm.user_id = target_user_id
      and fm.user_id <> auth.uid()
      and fm.role <> 'admin'
      and f.created_by <> fm.user_id;
    if not found then raise exception 'That member cannot be restricted by this account.'; end if;
    return true;
end;
$$;

create or replace function public.leave_family()
returns uuid
language plpgsql security definer set search_path = public, auth
as $$
declare
    v_family_id uuid;
    v_was_admin boolean;
begin
    if auth.uid() is null then raise exception 'Sign in to leave a family.'; end if;
    select fm.family_id, (fm.role = 'admin' or f.created_by = auth.uid())
    into v_family_id, v_was_admin
    from public.family_members fm
    join public.families f on f.id = fm.family_id
    where fm.user_id = auth.uid();
    if v_family_id is null then raise exception 'Your account is not a member of a family.'; end if;
    delete from public.family_members fm
    where fm.user_id = auth.uid();
    if v_was_admin then
        update public.family_members fm
        set role = 'admin'
        where fm.user_id = (
            select next_admin.user_id from public.family_members next_admin
            where next_admin.family_id = v_family_id
            order by next_admin.joined_at asc
            limit 1
        );
    end if;
    -- Keep the family, invite code, and shared budget for any remaining members.
    return v_family_id;
end;
$$;

create or replace function public.delete_family()
returns uuid
language plpgsql security definer set search_path = public, auth
as $$
declare
    v_family_id uuid;
begin
    if auth.uid() is null then raise exception 'Sign in to delete a family.'; end if;
    select fm.family_id into v_family_id
    from public.family_members fm where fm.user_id = auth.uid();
    if v_family_id is null or not public.is_family_admin(v_family_id) then
        raise exception 'Only the Family Admin can delete this family.';
    end if;

    -- This function runs only after an Admin confirms Delete Family in the app.
    delete from public.transactions t using public.monthly_budgets b
    where t.budget_id = b.id and b.family_id = v_family_id;
    delete from public.envelopes e using public.monthly_budgets b
    where e.budget_id = b.id and b.family_id = v_family_id;
    delete from public.monthly_budgets b where b.family_id = v_family_id;
    delete from public.family_members fm where fm.family_id = v_family_id;
    delete from public.families f where f.id = v_family_id;
    return v_family_id;
end;
$$;

revoke all on function public.is_family_member(uuid) from public;
revoke all on function public.is_family_admin(uuid) from public;
revoke all on function public.is_family_manager(uuid) from public;
revoke all on function public.is_personal_budget(uuid) from public;
revoke all on function public.is_family_member_for_budget(uuid) from public;
revoke all on function public.is_family_manager_for_budget(uuid) from public;
revoke all on function public.is_restricted_family_member_for_budget(uuid) from public;
revoke all on function public.get_family_members() from public;
revoke all on function public.set_family_member_restriction(uuid, boolean) from public;
revoke all on function public.leave_family() from public;
revoke all on function public.delete_family() from public;
grant execute on function public.is_family_member(uuid) to authenticated;
grant execute on function public.is_family_admin(uuid) to authenticated;
grant execute on function public.is_family_manager(uuid) to authenticated;
grant execute on function public.is_personal_budget(uuid) to authenticated;
grant execute on function public.is_family_member_for_budget(uuid) to authenticated;
grant execute on function public.is_family_manager_for_budget(uuid) to authenticated;
grant execute on function public.is_restricted_family_member_for_budget(uuid) to authenticated;
grant execute on function public.get_family_members() to authenticated;
grant execute on function public.set_family_member_restriction(uuid, boolean) to authenticated;
grant execute on function public.leave_family() to authenticated;
grant execute on function public.delete_family() to authenticated;

-- Replace the earlier all-member write policies with role-aware access.
drop policy if exists "Family members can access shared budgets" on public.monthly_budgets;
drop policy if exists "Family members can access shared envelopes" on public.envelopes;
drop policy if exists "Family members can access shared transactions" on public.transactions;
drop policy if exists "Family members can view shared budgets" on public.monthly_budgets;
drop policy if exists "Family managers can manage shared budgets" on public.monthly_budgets;
drop policy if exists "Family budget insert restriction" on public.monthly_budgets;
drop policy if exists "Family budget update restriction" on public.monthly_budgets;
drop policy if exists "Family budget delete restriction" on public.monthly_budgets;
drop policy if exists "Family members can view shared envelopes" on public.envelopes;
drop policy if exists "Family managers can manage shared envelopes" on public.envelopes;
drop policy if exists "Family envelope insert restriction" on public.envelopes;
drop policy if exists "Family envelope update restriction" on public.envelopes;
drop policy if exists "Family envelope delete restriction" on public.envelopes;
drop policy if exists "Family members can view shared transactions" on public.transactions;
drop policy if exists "Family members can add shared transactions" on public.transactions;
drop policy if exists "Family managers can manage shared transactions" on public.transactions;
drop policy if exists "Family transaction insert restriction" on public.transactions;
drop policy if exists "Family transaction update restriction" on public.transactions;
drop policy if exists "Family transaction delete restriction" on public.transactions;

create policy "Family members can view shared budgets" on public.monthly_budgets
    for select to authenticated using (family_id is not null and public.is_family_member(family_id));
create policy "Family managers can manage shared budgets" on public.monthly_budgets
    for all to authenticated
    using (family_id is not null and public.is_family_manager(family_id))
    with check (family_id is not null and public.is_family_manager(family_id));
create policy "Family budget insert restriction" on public.monthly_budgets
    as restrictive for insert to authenticated
    with check (family_id is null or public.is_family_manager(family_id));
create policy "Family budget update restriction" on public.monthly_budgets
    as restrictive for update to authenticated
    using (family_id is null or public.is_family_manager(family_id))
    with check (family_id is null or public.is_family_manager(family_id));
create policy "Family budget delete restriction" on public.monthly_budgets
    as restrictive for delete to authenticated
    using (family_id is null or public.is_family_manager(family_id));

create policy "Family members can view shared envelopes" on public.envelopes
    for select to authenticated using (public.is_family_member_for_budget(budget_id));
create policy "Family managers can manage shared envelopes" on public.envelopes
    for all to authenticated
    using (public.is_family_manager_for_budget(budget_id))
    with check (public.is_family_manager_for_budget(budget_id));
create policy "Family envelope insert restriction" on public.envelopes
    as restrictive for insert to authenticated
    with check (public.is_personal_budget(budget_id) or public.is_family_manager_for_budget(budget_id));
create policy "Family envelope update restriction" on public.envelopes
    as restrictive for update to authenticated
    using (public.is_personal_budget(budget_id) or public.is_family_manager_for_budget(budget_id))
    with check (public.is_personal_budget(budget_id) or public.is_family_manager_for_budget(budget_id));
create policy "Family envelope delete restriction" on public.envelopes
    as restrictive for delete to authenticated
    using (public.is_personal_budget(budget_id) or public.is_family_manager_for_budget(budget_id));

create policy "Family members can view shared transactions" on public.transactions
    for select to authenticated using (public.is_family_member_for_budget(budget_id));
create policy "Family members can add shared transactions" on public.transactions
    for insert to authenticated
    with check (public.is_family_member_for_budget(budget_id) and user_id = auth.uid());
create policy "Family managers can manage shared transactions" on public.transactions
    for all to authenticated
    using (public.is_family_manager_for_budget(budget_id))
    with check (public.is_family_manager_for_budget(budget_id));
create policy "Family transaction insert restriction" on public.transactions
    as restrictive for insert to authenticated
    with check (
        public.is_personal_budget(budget_id)
        or (
            public.is_family_member_for_budget(budget_id)
            and user_id = auth.uid()
            and (not public.is_restricted_family_member_for_budget(budget_id) or transaction_type = 'expense')
        )
    );
create policy "Family transaction update restriction" on public.transactions
    as restrictive for update to authenticated
    using (public.is_personal_budget(budget_id) or public.is_family_manager_for_budget(budget_id))
    with check (public.is_personal_budget(budget_id) or public.is_family_manager_for_budget(budget_id));
create policy "Family transaction delete restriction" on public.transactions
    as restrictive for delete to authenticated
    using (public.is_personal_budget(budget_id) or public.is_family_manager_for_budget(budget_id));
