
select cron.schedule('pulse-push-dispatch','*/5 * * * *',$job$
  select net.http_post(
    url:='https://pspiqukuhtazmkyfleii.supabase.co/functions/v1/pulse-push?action=dispatch',
    headers:=jsonb_build_object('Content-Type','application/json','x-cron-key',(select decrypted_secret from vault.decrypted_secrets where name='pulse_push_cron_secret' limit 1)),
    body:='{}'::jsonb,timeout_milliseconds:=60000);
$job$);
