-- Package-based stock. Existing item IDs and logs are preserved.
alter table public.tracked_items add column if not exists custom_category text;
alter table public.tracked_items add constraint tracked_items_custom_category_check check (custom_category is null or (category='other' and char_length(btrim(custom_category)) between 1 and 80));
alter table public.schedules add column if not exists end_date date;
alter table public.schedules add constraint schedules_date_range_check check (end_date is null or end_date>=start_date);
alter table public.inventory add column if not exists package_amount numeric;
alter table public.inventory add column if not exists package_type text;
alter table public.inventory add column if not exists managed_schedule_id uuid references public.schedules(id) on delete set null;
alter table public.inventory add constraint inventory_package_check check (
  (package_amount is null and package_type is null) or
  (package_amount is not null and package_type is not null and package_amount>0 and package_amount<='1000000000'::numeric and package_type in ('vial','bottle','pack') and unit in ('mg','mL'))
);
alter table public.inventory add constraint inventory_finite_stock_check check (
  quantity::text not in ('NaN','Infinity','-Infinity') and
  (low_threshold is null or low_threshold::text not in ('NaN','Infinity','-Infinity')) and
  (strength_amount is null or strength_amount::text not in ('NaN','Infinity','-Infinity')) and
  (strength_per_amount is null or strength_per_amount::text not in ('NaN','Infinity','-Infinity'))
);
alter table public.logs add column if not exists inventory_id uuid references public.inventory(id) on delete set null;
alter table public.logs add column if not exists inventory_deducted numeric not null default 0 check (inventory_deducted>=0);
alter table public.logs add column if not exists inventory_accounted boolean not null default false;
create index if not exists logs_inventory_id_idx on public.logs(inventory_id) where inventory_id is not null;
create index if not exists inventory_managed_schedule_id_idx on public.inventory(managed_schedule_id) where managed_schedule_id is not null;
create unique index if not exists logs_one_schedule_occurrence_idx on public.logs(user_id,schedule_id,scheduled_for) where schedule_id is not null and scheduled_for is not null;

create or replace function public.pulse_stock_dose(p_amount numeric,p_unit text,p_stock public.inventory)
returns numeric language plpgsql immutable security invoker set search_path='' as $$
begin
  if p_amount is null or p_amount<=0 or p_amount::text in ('NaN','Infinity','-Infinity') then
    raise exception 'Enter a dose greater than zero.';
  end if;
  if lower(p_unit)=lower(p_stock.unit) then return round(p_amount,8); end if;
  if p_stock.strength_amount>0 and p_stock.strength_per_amount>0 then
    if lower(p_unit)=lower(p_stock.strength_unit) and lower(p_stock.unit)=lower(p_stock.strength_per_unit) then
      return round(p_amount*p_stock.strength_per_amount/p_stock.strength_amount,8);
    elsif lower(p_unit)=lower(p_stock.strength_per_unit) and lower(p_stock.unit)=lower(p_stock.strength_unit) then
      return round(p_amount*p_stock.strength_amount/p_stock.strength_per_amount,8);
    end if;
  end if;
  raise exception 'Add the total mg and mL in each package before logging a dose in a different unit.';
end $$;

create or replace function public.pulse_inventory_totals()
returns trigger language plpgsql security invoker set search_path='' as $$
begin
  if new.package_amount is not null then
    new.containers_on_hand:=ceil(round(new.quantity/new.package_amount,8));
  end if;
  new.updated_at:=clock_timestamp();
  return new;
end $$;
create trigger pulse_inventory_totals before insert or update on public.inventory for each row execute function public.pulse_inventory_totals();

-- The log and stock change succeed or fail together. Store the original deduction
-- so later edits and deletions reverse the amount that was actually consumed.
create or replace function public.pulse_account_log()
returns trigger language plpgsql security invoker set search_path='' as $$
declare
  v_stock public.inventory;
  v_amount numeric:=0;
begin
  if tg_op='DELETE' then
    if old.inventory_deducted>0 and old.inventory_id is not null then
      update public.inventory set quantity=quantity+old.inventory_deducted
      where id=old.inventory_id and user_id=old.user_id;
    end if;
    return old;
  end if;
  if tg_op='UPDATE' then
    if new.user_id<>old.user_id or new.tracked_item_id<>old.tracked_item_id then
      raise exception 'A log cannot be moved to another user or item.';
    end if;
    -- Allow the inventory FK to detach historical logs when stock is deleted.
    if old.inventory_id is not null and new.inventory_id is null and
       not exists(select 1 from public.inventory where id=old.inventory_id and user_id=old.user_id) then
      new.inventory_deducted:=0;
      new.inventory_accounted:=false;
      return new;
    end if;
    new.inventory_id:=old.inventory_id;
    new.inventory_deducted:=old.inventory_deducted;
    new.inventory_accounted:=old.inventory_accounted;
    if (new.amount,new.unit,new.status) is not distinct from (old.amount,old.unit,old.status)
       or not old.inventory_accounted then return new; end if;
    -- Logs entered before an inventory record existed do not consume newly added stock retroactively.
    if old.inventory_id is null and old.status='completed' then return new; end if;
  end if;
  select * into v_stock from public.inventory
  where tracked_item_id=new.tracked_item_id and user_id=new.user_id for update;
  new.inventory_id:=v_stock.id;
  new.inventory_deducted:=0;
  new.inventory_accounted:=true;
  if v_stock.id is null then return new; end if;
  if tg_op='UPDATE' and old.inventory_id=v_stock.id then
    v_stock.quantity:=v_stock.quantity+old.inventory_deducted;
  end if;
  if new.status='completed' and v_stock.auto_decrement then
    if v_stock.package_amount is not null then
      v_amount:=public.pulse_stock_dose(new.amount,new.unit,v_stock);
    else
      v_amount:=coalesce(v_stock.decrement_amount,0);
    end if;
    if v_amount<=0 then raise exception 'Enter a dose that can be deducted from stock.'; end if;
    if v_amount>v_stock.quantity then
      raise exception 'Not enough stock for this dose. Update inventory before saving the log.';
    end if;
    new.inventory_deducted:=v_amount;
  end if;
  update public.inventory set quantity=round(v_stock.quantity-v_amount,8)
  where id=v_stock.id and user_id=new.user_id;
  return new;
end $$;
create trigger pulse_account_log before insert or update or delete on public.logs for each row execute function public.pulse_account_log();

-- Older installed clients still call this after inserting a log. Accounting now
-- happens in the trigger, so return current stock without subtracting twice.
create or replace function public.decrement_inventory(p_inventory_id uuid,p_amount numeric)
returns numeric language sql security invoker set search_path='' as $$
  select quantity from public.inventory where id=p_inventory_id and user_id=(select auth.uid());
$$;

create or replace function public.pulse_save_inventory(
  p_item_id uuid,p_inventory_id uuid,p_item jsonb,p_stock jsonb,p_schedule jsonb
) returns jsonb language plpgsql security invoker set search_path='' as $$
declare
  v_user uuid:=auth.uid();
  v_item uuid:=p_item_id;
  v_stock public.inventory;
  v_schedule uuid;
  v_capacity numeric:=(p_stock->>'package_amount')::numeric;
  v_quantity numeric;
  v_unit text:=p_stock->>'unit';
  v_amount numeric:=(p_item->>'default_amount')::numeric;
  v_days smallint[];
  v_dose numeric;
begin
  if v_user is null then raise exception 'Sign in to manage inventory.'; end if;
  if v_capacity is null or v_capacity<=0 or v_capacity::text in ('NaN','Infinity','-Infinity') or v_unit not in ('mg','mL') then
    raise exception 'Enter the full package amount in mg or mL.';
  end if;
  if v_amount is null or v_amount<=0 or p_item->>'default_unit' not in ('mg','mL') then
    raise exception 'Enter your dose in mg or mL.';
  end if;
  if p_inventory_id is not null then
    select * into v_stock from public.inventory where id=p_inventory_id and user_id=v_user for update;
    if v_stock.id is null or v_stock.tracked_item_id is distinct from v_item then raise exception 'Inventory not found.'; end if;
    if v_stock.unit<>v_unit and exists(select 1 from public.logs where inventory_id=v_stock.id and inventory_deducted>0) then
      raise exception 'Keep the stock unit used by existing logs. Enter the other unit as your dose instead.';
    end if;
    if p_stock->>'quantity' is not null and v_stock.updated_at is distinct from (p_stock->>'expected_updated_at')::timestamptz then
      raise exception 'Stock changed while this form was open. Reopen inventory before adjusting the amount.';
    end if;
    v_quantity:=coalesce((p_stock->>'quantity')::numeric,v_stock.quantity);
    v_schedule:=v_stock.managed_schedule_id;
  else
    v_quantity:=(p_stock->>'quantity')::numeric;
  end if;
  if v_quantity is null or v_quantity<0 or v_quantity::text in ('NaN','Infinity','-Infinity') then raise exception 'Enter a valid package count.'; end if;
  if v_item is null then
    insert into public.tracked_items(user_id,name,category,custom_category,form,default_amount,default_unit)
    values(v_user,btrim(p_item->>'name'),p_item->>'category',nullif(btrim(p_item->>'custom_category'),''),p_item->>'form',v_amount,p_item->>'default_unit') returning id into v_item;
  else
    update public.tracked_items set name=btrim(p_item->>'name'),category=p_item->>'category',custom_category=nullif(btrim(p_item->>'custom_category'),''),
      form=p_item->>'form',default_amount=v_amount,default_unit=p_item->>'default_unit',updated_at=now()
    where id=v_item and user_id=v_user;
    if not found then raise exception 'Item not found.'; end if;
  end if;
  -- Validate conversion before writing any part of the setup.
  v_stock.unit:=v_unit;
  v_stock.strength_amount:=(p_stock->>'strength_amount')::numeric;
  v_stock.strength_unit:=p_stock->>'strength_unit';
  v_stock.strength_per_amount:=(p_stock->>'strength_per_amount')::numeric;
  v_stock.strength_per_unit:=p_stock->>'strength_per_unit';
  v_dose:=public.pulse_stock_dose(v_amount,p_item->>'default_unit',v_stock);
  if v_dose<=0 then raise exception 'The dose is too small to track accurately.'; end if;
  if coalesce((p_schedule->>'enabled')::boolean,false) then
    v_days:=array(select distinct x::smallint from jsonb_array_elements_text(p_schedule->'days_of_week') x order by 1);
    if cardinality(v_days)=0 or not v_days<@array[0,1,2,3,4,5,6]::smallint[] or nullif(p_schedule->>'scheduled_time','') is null then
      raise exception 'Choose at least one day and a reminder time.';
    end if;
    if v_schedule is null then v_schedule:=nullif(p_schedule->>'id','')::uuid; end if;
    if v_schedule is not null then
      update public.schedules set frequency=case when cardinality(v_days)=7 then 'daily' else 'weekly' end,
        scheduled_time=(p_schedule->>'scheduled_time')::time,days_of_week=v_days,interval_days=null,
        start_date=(p_schedule->>'start_date')::date,end_date=nullif(p_schedule->>'end_date','')::date,active=true,updated_at=now()
      where id=v_schedule and tracked_item_id=v_item and user_id=v_user;
      if not found then raise exception 'Schedule not found.'; end if;
    else
      insert into public.schedules(user_id,tracked_item_id,frequency,scheduled_time,days_of_week,start_date,end_date)
      values(v_user,v_item,case when cardinality(v_days)=7 then 'daily' else 'weekly' end,(p_schedule->>'scheduled_time')::time,v_days,
        (p_schedule->>'start_date')::date,nullif(p_schedule->>'end_date','')::date) returning id into v_schedule;
    end if;
  elsif v_schedule is not null then
    update public.schedules set active=false,updated_at=now() where id=v_schedule and user_id=v_user;
  end if;
  if p_inventory_id is null then
    insert into public.inventory(user_id,tracked_item_id,quantity,unit,package_amount,package_type,low_threshold,auto_decrement,
      strength_amount,strength_unit,strength_per_amount,strength_per_unit,lot_number,expiration_date,managed_schedule_id)
    values(v_user,v_item,v_quantity,v_unit,v_capacity,p_stock->>'package_type',(p_stock->>'low_threshold')::numeric,true,
      v_stock.strength_amount,v_stock.strength_unit,v_stock.strength_per_amount,v_stock.strength_per_unit,
      nullif(p_stock->>'lot_number',''),nullif(p_stock->>'expiration_date','')::date,v_schedule) returning * into v_stock;
  else
    update public.inventory set quantity=v_quantity,unit=v_unit,package_amount=v_capacity,package_type=p_stock->>'package_type',
      low_threshold=(p_stock->>'low_threshold')::numeric,auto_decrement=true,decrement_amount=null,
      strength_amount=v_stock.strength_amount,strength_unit=v_stock.strength_unit,strength_per_amount=v_stock.strength_per_amount,strength_per_unit=v_stock.strength_per_unit,
      lot_number=nullif(p_stock->>'lot_number',''),expiration_date=nullif(p_stock->>'expiration_date','')::date,managed_schedule_id=v_schedule
    where id=p_inventory_id and user_id=v_user returning * into v_stock;
  end if;
  return jsonb_build_object('item_id',v_item,'inventory_id',v_stock.id,'schedule_id',v_schedule);
end $$;

revoke all on function public.pulse_stock_dose(numeric,text,public.inventory) from public,anon;
revoke all on function public.pulse_inventory_totals() from public,anon;
revoke all on function public.pulse_account_log() from public,anon;
revoke all on function public.pulse_save_inventory(uuid,uuid,jsonb,jsonb,jsonb) from public,anon;
revoke all on function public.decrement_inventory(uuid,numeric) from public,anon;
grant execute on function public.pulse_stock_dose(numeric,text,public.inventory) to authenticated,service_role;
grant execute on function public.pulse_save_inventory(uuid,uuid,jsonb,jsonb,jsonb) to authenticated;
grant execute on function public.decrement_inventory(uuid,numeric) to authenticated;

