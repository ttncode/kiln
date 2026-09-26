-- audit_events receives one row per user action; about 2 million rows a month, never pruned.
CREATE TABLE audit_events (id bigserial PRIMARY KEY, actor_id bigint, action text, payload jsonb, created_at timestamptz DEFAULT now());
