-- Attribute generic AI suggestion calls in usage accounting.
--
-- `ai_call` is intentionally server-written only, so this does not grant a
-- browser client any new write power. It just lets the DPO audit "this review
-- item came from that model call" instead of seeing tenant-level cost blobs.

alter type public.ai_task add value if not exists 'ai_suggestion_generation';

alter table public.ai_call
  add column ai_suggestion_id uuid;

alter table public.ai_call
  add constraint ai_call_suggestion_same_tenant
    foreign key (ai_suggestion_id, tenant_id)
    references public.ai_suggestion (id, tenant_id)
    on delete restrict;

create index ai_call_suggestion_idx
  on public.ai_call (tenant_id, ai_suggestion_id)
  where ai_suggestion_id is not null;
