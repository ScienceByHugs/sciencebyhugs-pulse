alter table public.push_subscriptions add column if not exists last_test_at timestamptz;
-- Endpoint validation and ownership transfers are handled by the authenticated Edge Function.
revoke insert,update on public.push_subscriptions from authenticated,anon;
