-- Rollback-only regression checks; no real account or stock survives this file.
begin;
select set_config('pulse.test_user',gen_random_uuid()::text,true);
insert into auth.users(id,email) values(current_setting('pulse.test_user')::uuid,'pulse-test-'||current_setting('pulse.test_user')||'@example.invalid');
select set_config('request.jwt.claim.sub',current_setting('pulse.test_user'),true);
set local role authenticated;
do $$
declare v_setup jsonb;v_item uuid;v_inv uuid;v_log uuid;v_qty numeric;v_count numeric;v_failed boolean;
begin
  v_setup:=public.pulse_save_inventory(null,null,
    '{"name":"Inventory test","category":"other","custom_category":"Test category","form":"oral","default_amount":2,"default_unit":"mg"}',
    '{"quantity":30,"unit":"mg","package_amount":10,"package_type":"vial","low_threshold":10,"strength_amount":10,"strength_unit":"mg","strength_per_amount":1,"strength_per_unit":"mL"}',
    '{"enabled":true,"days_of_week":[1,3,5],"scheduled_time":"08:00","start_date":"2026-09-01","end_date":"2026-09-30"}');
  v_item:=(v_setup->>'item_id')::uuid;v_inv:=(v_setup->>'inventory_id')::uuid;
  if not exists(select 1 from public.schedules where id=(v_setup->>'schedule_id')::uuid and end_date='2026-09-30') then raise exception 'Stop date missing';end if;
  insert into public.logs(user_id,tracked_item_id,amount,unit,status) values(auth.uid(),v_item,2,'mg','completed') returning id into v_log;
  select quantity into v_qty from public.inventory where id=v_inv;if v_qty<>28 then raise exception 'Deduction failed';end if;
  update public.logs set amount=4 where id=v_log;
  select quantity into v_qty from public.inventory where id=v_inv;if v_qty<>26 then raise exception 'Edit failed';end if;
  update public.logs set status='skipped' where id=v_log;
  select quantity into v_qty from public.inventory where id=v_inv;if v_qty<>30 then raise exception 'Skip restoration failed';end if;
  update public.logs set status='completed',amount=.2,unit='mL' where id=v_log;
  select quantity into v_qty from public.inventory where id=v_inv;if v_qty<>28 then raise exception 'Conversion failed';end if;
  update public.logs set notes='No double deduction',inventory_deducted=25,inventory_id=null where id=v_log;
  if not exists(select 1 from public.logs where id=v_log and inventory_deducted=2 and inventory_id=v_inv) then raise exception 'Ledger can be forged';end if;
  delete from public.logs where id=v_log;
  select quantity into v_qty from public.inventory where id=v_inv;if v_qty<>30 then raise exception 'Delete restoration failed';end if;
  insert into public.logs(user_id,tracked_item_id,amount,unit,status) values(auth.uid(),v_item,10,'mg','completed');
  perform public.decrement_inventory(v_inv,10);
  select quantity,containers_on_hand into v_qty,v_count from public.inventory where id=v_inv;if v_qty<>20 or v_count<>2 then raise exception 'Boundary or older client double deduction failed';end if;
  v_failed:=false;begin insert into public.logs(user_id,tracked_item_id,amount,unit,status) values(auth.uid(),v_item,21,'mg','completed');exception when others then v_failed:=true;end;
  select quantity into v_qty from public.inventory where id=v_inv;if not v_failed or v_qty<>20 then raise exception 'Overspending did not roll back';end if;
  insert into public.logs(user_id,tracked_item_id,schedule_id,scheduled_for,amount,unit,status) values(auth.uid(),v_item,(v_setup->>'schedule_id')::uuid,'2026-09-30T08:00:00Z',2,'mg','completed') returning id into v_log;
  v_failed:=false;begin insert into public.logs(user_id,tracked_item_id,schedule_id,scheduled_for,amount,unit,status) values(auth.uid(),v_item,(v_setup->>'schedule_id')::uuid,'2026-09-30T08:00:00Z',2,'mg','completed');exception when unique_violation then v_failed:=true;end;
  select quantity into v_qty from public.inventory where id=v_inv;if not v_failed or v_qty<>18 then raise exception 'Duplicate occurrence consumed stock';end if;
  delete from public.logs where id=v_log;
  delete from public.inventory where id=v_inv;
  if exists(select 1 from public.logs where tracked_item_id=v_item and inventory_id is not null) then raise exception 'Inventory deletion damaged history';end if;
end $$;
reset role;
select 'PASS: package inventory accounting and rollback tests' as verification;
rollback;
