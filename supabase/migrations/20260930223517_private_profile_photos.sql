-- Private profile photos. Nexus and Core share the same user-owned object.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('avatars', 'avatars', false, 1048576, array['image/jpeg'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

create policy "avatar_read_own" on storage.objects for select to authenticated
using (bucket_id = 'avatars' and name = (select auth.uid())::text || '/avatar.jpg');
create policy "avatar_insert_own" on storage.objects for insert to authenticated
with check (bucket_id = 'avatars' and name = (select auth.uid())::text || '/avatar.jpg');
create policy "avatar_update_own" on storage.objects for update to authenticated
using (bucket_id = 'avatars' and name = (select auth.uid())::text || '/avatar.jpg')
with check (bucket_id = 'avatars' and name = (select auth.uid())::text || '/avatar.jpg');
create policy "avatar_delete_own" on storage.objects for delete to authenticated
using (bucket_id = 'avatars' and name = (select auth.uid())::text || '/avatar.jpg');
