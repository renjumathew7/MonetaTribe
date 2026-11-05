-- Installs the Admin-only Delete Family RPC used by the Profile button.
-- Running this defines the function and its permissions; it does not delete data.
-- Actual family data is deleted only when an Admin confirms Delete Family in the app.

create or replace function public.delete_family()
returns uuid
language plpgsql
security definer
set search_path = public, auth
as $$
declare
    v_family_id uuid;
begin
    if auth.uid() is null then
        raise exception 'Sign in to delete a family.';
    end if;

    select fm.family_id into v_family_id
    from public.family_members fm
    where fm.user_id = auth.uid();

    if v_family_id is null or not public.is_family_admin(v_family_id) then
        raise exception 'Only the Family Admin can delete this family.';
    end if;

    -- Remove child rows first, then the family. Personal budgets are untouched.
    delete from public.transactions t
    using public.monthly_budgets b
    where t.budget_id = b.id and b.family_id = v_family_id;

    delete from public.envelopes e
    using public.monthly_budgets b
    where e.budget_id = b.id and b.family_id = v_family_id;

    delete from public.monthly_budgets b where b.family_id = v_family_id;
    delete from public.family_members fm where fm.family_id = v_family_id;
    delete from public.families f where f.id = v_family_id;

    return v_family_id;
end;
$$;

revoke all on function public.delete_family() from public;
grant execute on function public.delete_family() to authenticated;
