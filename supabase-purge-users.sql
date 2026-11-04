-- Purge all Supabase Auth accounts except the two listed below.
-- Preserves family records and shared budgets if either retained account is a member.
-- Shared rows owned by an account being purged are reassigned to a retained family
-- member first. Personal budgets and related rows for purged accounts are removed
-- through the project's ON DELETE CASCADE foreign keys.
--
-- SAFETY: This script is preview-only by default. Review the notices, then change
-- v_execute below from false to true and run the complete script again to purge.
-- Take a Supabase backup/export first. Run as the Supabase SQL Editor postgres role.

begin;

create temporary table purge_keep_users on commit drop as
select id, email
from auth.users
where lower(email) in ('renjumathew7@gmail.com', 'renjuvenetion@gmail.com');

create temporary table purge_target_users on commit drop as
select id, email
from auth.users
where email is null
   or lower(email) not in ('renjumathew7@gmail.com', 'renjuvenetion@gmail.com');

do $$
declare
    v_execute boolean := true; -- Change to true only after reviewing preview notices.
    v_keep_count integer;
    v_target_count integer;
    v_family_count integer;
    v_personal_budget_count integer;
    v_personal_pocket_count integer;
    v_personal_transaction_count integer;
begin
    select count(*) into v_keep_count from purge_keep_users;
    if v_keep_count <> 2 then
        raise exception 'Safety stop: expected both retained emails to exist in auth.users; found % of 2.', v_keep_count;
    end if;

    select count(*) into v_target_count from purge_target_users;
    select count(*) into v_family_count
    from public.families f
    where not exists (
        select 1 from public.family_members fm
        join purge_keep_users k on k.id = fm.user_id
        where fm.family_id = f.id
    );
    select count(*) into v_personal_budget_count
    from public.monthly_budgets b join purge_target_users t on t.id = b.user_id
    where b.family_id is null;
    select count(*) into v_personal_pocket_count
    from public.envelopes e join purge_target_users t on t.id = e.user_id
    where not exists (
        select 1 from public.monthly_budgets b
        join public.family_members fm on fm.family_id = b.family_id
        join purge_keep_users k on k.id = fm.user_id
        where b.id = e.budget_id and b.family_id is not null
    );
    select count(*) into v_personal_transaction_count
    from public.transactions x join purge_target_users t on t.id = x.user_id
    where not exists (
        select 1 from public.monthly_budgets b
        join public.family_members fm on fm.family_id = b.family_id
        join purge_keep_users k on k.id = fm.user_id
        where b.id = x.budget_id and b.family_id is not null
    );

    raise notice 'Accounts to retain: %', v_keep_count;
    raise notice 'Accounts to purge: %', v_target_count;
    raise notice 'Families with no retained member (and their shared data) to remove: %', v_family_count;
    raise notice 'Personal budgets belonging to purge accounts: %', v_personal_budget_count;
    raise notice 'Pockets directly owned by purge accounts outside retained family budgets: %', v_personal_pocket_count;
    raise notice 'Transactions directly owned by purge accounts outside retained family budgets: %', v_personal_transaction_count;
    raise notice 'Families containing either retained account and their shared data will be preserved.';

    if not v_execute then
        raise notice 'PREVIEW ONLY: no data was changed. To execute, change v_execute to true and rerun.';
        return;
    end if;

    -- Pick one retained member per surviving family for records owned by deleted accounts.
    create temporary table purge_family_owners on commit drop as
    select distinct on (fm.family_id) fm.family_id, fm.user_id as retained_user_id
    from public.family_members fm
    join purge_keep_users k on k.id = fm.user_id
    order by fm.family_id, fm.joined_at, fm.user_id;

    -- Preserve surviving families even if their original creator is being removed.
    update public.families f
    set created_by = o.retained_user_id
    from purge_family_owners o
    where f.id = o.family_id
      and exists (select 1 from purge_target_users t where t.id = f.created_by);

    -- Keep shared budget, pocket, and transaction rows when their old owner is purged.
    update public.monthly_budgets b
    set user_id = o.retained_user_id
    from purge_family_owners o
    where b.family_id = o.family_id
      and exists (select 1 from purge_target_users t where t.id = b.user_id);

    update public.envelopes e
    set user_id = o.retained_user_id
    from public.monthly_budgets b
    join purge_family_owners o on o.family_id = b.family_id
    where e.budget_id = b.id
      and exists (select 1 from purge_target_users t where t.id = e.user_id);

    update public.transactions x
    set user_id = o.retained_user_id
    from public.monthly_budgets b
    join purge_family_owners o on o.family_id = b.family_id
    where x.budget_id = b.id
      and exists (select 1 from purge_target_users t where t.id = x.user_id);

    -- Delete families without either retained user; family_id cascades remove shared rows.
    delete from public.families f
    where not exists (
        select 1 from public.family_members fm
        join purge_keep_users k on k.id = fm.user_id
        where fm.family_id = f.id
    );

    -- Deleting Auth users cascades their personal records, memberships, and identities.
    delete from auth.users u
    using purge_target_users t
    where u.id = t.id;

    raise notice 'Purge completed. Retained accounts: renjumathew7@gmail.com and renjuvenetion@gmail.com.';
end;
$$;

commit;
