-- 跨设备同步：Supabase 侧的结构与访问控制
--
-- 在 Supabase 控制台的 SQL Editor 中整体执行一次即可。
-- 这里只做三件事：建存储桶、给每个用户划定自己的目录、把权限收紧到只能操作本人数据。

-- ─── 1. 私有存储桶 ───
-- public = false 表示文件不能通过公开链接访问，必须带用户令牌。
insert into storage.buckets (id, name, public)
values ('read-something-sync', 'read-something-sync', false)
on conflict (id) do nothing;

-- ─── 2. 存储桶策略 ───
-- 约定：所有文件都放在以 user id 命名的顶层目录下，例如
--   <user-id>/manifest.json
--   <user-id>/latest.bin
--   <user-id>/versions/<时间戳>.bin
-- storage.foldername(name) 的第一个元素就是顶层目录名。

drop policy if exists "sync_owner_read" on storage.objects;
create policy "sync_owner_read"
on storage.objects for select
to authenticated
using (
  bucket_id = 'read-something-sync'
  and (storage.foldername(name))[1] = auth.uid()::text
);

drop policy if exists "sync_owner_insert" on storage.objects;
create policy "sync_owner_insert"
on storage.objects for insert
to authenticated
with check (
  bucket_id = 'read-something-sync'
  and (storage.foldername(name))[1] = auth.uid()::text
);

drop policy if exists "sync_owner_update" on storage.objects;
create policy "sync_owner_update"
on storage.objects for update
to authenticated
using (
  bucket_id = 'read-something-sync'
  and (storage.foldername(name))[1] = auth.uid()::text
)
with check (
  bucket_id = 'read-something-sync'
  and (storage.foldername(name))[1] = auth.uid()::text
);

drop policy if exists "sync_owner_delete" on storage.objects;
create policy "sync_owner_delete"
on storage.objects for delete
to authenticated
using (
  bucket_id = 'read-something-sync'
  and (storage.foldername(name))[1] = auth.uid()::text
);

-- ─── 3. 可选的元数据表 ───
-- 同步本身只依赖对象存储。如果以后想在服务端统计同步次数、做设备列表或
-- 在 Web 端直接查询「哪些设备最近在同步」，可以启用下面这张表。
-- 它对当前前端不是必需的。

create table if not exists public.sync_devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  client_id text not null,
  device_label text,
  last_synced_at timestamptz not null default now(),
  last_object_name text,
  size_bytes bigint,
  encrypted boolean not null default true,
  created_at timestamptz not null default now(),
  unique (user_id, client_id)
);

alter table public.sync_devices enable row level security;

drop policy if exists "sync_devices_owner_all" on public.sync_devices;
create policy "sync_devices_owner_all"
on public.sync_devices for all
to authenticated
using (user_id = auth.uid())
with check (user_id = auth.uid());

-- 行级安全必须开启，否则 anon key 就等同于完全放行。
-- 可以用下面这条语句自查本库里还有哪些表没开 RLS：
--   select relname from pg_class
--   where relkind = 'r' and relnamespace = 'public'::regnamespace
--     and not relrowsecurity;
