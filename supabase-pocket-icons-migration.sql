-- Run once in the Supabase SQL Editor to persist Pocket icons.
-- This is additive: it adds one column and leaves existing budget data intact.

alter table public.envelopes
    add column if not exists icon_key text not null default 'general';
