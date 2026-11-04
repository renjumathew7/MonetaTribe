-- READ ONLY PREVIEW. This does not delete or modify anything.
-- Run in Supabase SQL Editor and review the results before preparing the purge.

-- 1. Accounts that would be retained or purged.
with keep_emails(email) as (
    values ('renjumathew7@gmail.com'), ('renjuvenetion@gmail.com')
)
select
    u.id,
    u.email,
    case when lower(u.email) in (select lower(email) from keep_emails)
         then 'KEEP' else 'WOULD PURGE' end as proposed_action,
    u.created_at
from auth.users u
order by proposed_action, lower(u.email);

-- 2. Personal budgets and their related records for each account that would be purged.
with keep_emails(email) as (
    values ('renjumathew7@gmail.com'), ('renjuvenetion@gmail.com')
), targets as (
    select u.id, u.email
    from auth.users u
    where lower(u.email) not in (select lower(email) from keep_emails)
)
select
    t.email,
    count(distinct b.id) as personal_budgets,
    count(distinct e.id) as pockets,
    count(distinct x.id) as transactions
from targets t
left join public.monthly_budgets b on b.user_id = t.id and b.family_id is null
left join public.envelopes e on e.budget_id = b.id
left join public.transactions x on x.budget_id = b.id
group by t.email
order by lower(t.email);

-- 3. Families: families with a retained member should keep shared data;
-- families with no retained members would be removed with their shared data.
with keep_emails(email) as (
    values ('renjumathew7@gmail.com'), ('renjuvenetion@gmail.com')
), retained as (
    select id, email from auth.users
    where lower(email) in (select lower(email) from keep_emails)
)
select
    f.id as family_id,
    f.name as family_name,
    f.invite_code,
    f.created_by,
    creator.email as created_by_email,
    count(distinct fm.user_id) as current_members,
    count(distinct r.id) as retained_members,
    count(distinct b.id) as shared_budgets,
    count(distinct e.id) as shared_pockets,
    count(distinct x.id) as shared_transactions,
    case when count(distinct r.id) > 0
         then 'KEEP FAMILY AND SHARED DATA' else 'WOULD DELETE FAMILY AND SHARED DATA' end as proposed_action
from public.families f
left join auth.users creator on creator.id = f.created_by
left join public.family_members fm on fm.family_id = f.id
left join retained r on r.id = fm.user_id
left join public.monthly_budgets b on b.family_id = f.id
left join public.envelopes e on e.budget_id = b.id
left join public.transactions x on x.budget_id = b.id
group by f.id, f.name, f.invite_code, f.created_by, creator.email
order by lower(f.name);

-- 4. Check other public tables that directly reference auth.users. This is also
-- read-only and helps identify any additional user-owned data in this project.
select
    ns.nspname as schema_name,
    tbl.relname as table_name,
    att.attname as user_reference_column,
    con.conname as foreign_key_name,
    pg_get_constraintdef(con.oid) as foreign_key_definition
from pg_constraint con
join pg_class tbl on tbl.oid = con.conrelid
join pg_namespace ns on ns.oid = tbl.relnamespace
join unnest(con.conkey) with ordinality as key_col(attnum, ord) on true
join pg_attribute att on att.attrelid = tbl.oid and att.attnum = key_col.attnum
where con.contype = 'f'
  and con.confrelid = 'auth.users'::regclass
  and ns.nspname = 'public'
order by tbl.relname, att.attname;
