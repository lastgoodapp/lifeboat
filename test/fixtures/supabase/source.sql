-- A database shaped like a Supabase project: its roles, schemas, extensions, Auth and Storage tables,
-- an app schema with RLS policies, a sign-up trigger on auth.users, a realtime publication and event triggers.
-- pg_graphql, pgsodium, supabase_vault, pg_net and pgjwt are the stubs in stubs/, which stock Postgres lacks.
-- make-dump.sh turns this into dump.backup. Every address and value in it is made up.
\set ON_ERROR_STOP 1

CREATE ROLE supabase_admin SUPERUSER LOGIN;
CREATE ROLE anon NOLOGIN NOINHERIT;
CREATE ROLE authenticated NOLOGIN NOINHERIT;
CREATE ROLE service_role NOLOGIN NOINHERIT BYPASSRLS;
CREATE ROLE authenticator LOGIN NOINHERIT;
GRANT anon, authenticated, service_role TO authenticator;
CREATE ROLE supabase_auth_admin LOGIN NOINHERIT CREATEROLE;
CREATE ROLE supabase_storage_admin LOGIN NOINHERIT CREATEROLE;
CREATE ROLE dashboard_user NOLOGIN CREATEDB CREATEROLE;
CREATE ROLE pgbouncer LOGIN;

CREATE SCHEMA extensions;
CREATE SCHEMA graphql;
CREATE SCHEMA graphql_public;
CREATE SCHEMA pgsodium;
CREATE SCHEMA vault;
CREATE SCHEMA auth AUTHORIZATION supabase_auth_admin;
CREATE SCHEMA storage AUTHORIZATION supabase_storage_admin;
CREATE SCHEMA realtime;
CREATE SCHEMA supabase_migrations;
CREATE SCHEMA pgbouncer;

CREATE EXTENSION pgcrypto WITH SCHEMA extensions;
CREATE EXTENSION "uuid-ossp" WITH SCHEMA extensions;
CREATE EXTENSION pg_stat_statements WITH SCHEMA extensions;
CREATE EXTENSION pgjwt WITH SCHEMA extensions;
CREATE EXTENSION pg_graphql WITH SCHEMA graphql;
CREATE EXTENSION pgsodium WITH SCHEMA pgsodium;
CREATE EXTENSION supabase_vault WITH SCHEMA vault;
CREATE EXTENSION pg_net WITH SCHEMA extensions;
COMMENT ON SCHEMA public IS 'standard public schema';
COMMENT ON EXTENSION pg_graphql IS 'pg_graphql: GraphQL support';

-- Event triggers Supabase installs. Their functions live in the extensions schema.
CREATE FUNCTION extensions.grant_pg_graphql_access() RETURNS event_trigger LANGUAGE plpgsql AS $$ BEGIN END $$;
CREATE FUNCTION extensions.set_graphql_placeholder() RETURNS event_trigger LANGUAGE plpgsql AS $$ BEGIN END $$;
CREATE FUNCTION extensions.pgrst_ddl_watch() RETURNS event_trigger LANGUAGE plpgsql AS $$ BEGIN END $$;
CREATE FUNCTION extensions.pgrst_drop_watch() RETURNS event_trigger LANGUAGE plpgsql AS $$ BEGIN END $$;
CREATE EVENT TRIGGER issue_pg_graphql_access ON ddl_command_end WHEN TAG IN ('CREATE FUNCTION') EXECUTE FUNCTION extensions.grant_pg_graphql_access();
CREATE EVENT TRIGGER issue_graphql_placeholder ON sql_drop WHEN TAG IN ('DROP EXTENSION') EXECUTE FUNCTION extensions.set_graphql_placeholder();
CREATE EVENT TRIGGER pgrst_ddl_watch ON ddl_command_end EXECUTE FUNCTION extensions.pgrst_ddl_watch();
CREATE EVENT TRIGGER pgrst_drop_watch ON sql_drop EXECUTE FUNCTION extensions.pgrst_drop_watch();

-- Supabase Auth.
SET ROLE supabase_auth_admin;
CREATE TYPE auth.aal_level AS ENUM ('aal1', 'aal2', 'aal3');
CREATE TYPE auth.factor_type AS ENUM ('totp', 'webauthn', 'phone');
CREATE TABLE auth.users (
  instance_id uuid,
  id uuid PRIMARY KEY,
  aud varchar(255),
  role varchar(255),
  email varchar(255),
  encrypted_password varchar(255),
  email_confirmed_at timestamptz,
  invited_at timestamptz,
  confirmation_token varchar(255),
  recovery_token varchar(255),
  last_sign_in_at timestamptz,
  raw_app_meta_data jsonb,
  raw_user_meta_data jsonb,
  is_super_admin boolean,
  created_at timestamptz,
  updated_at timestamptz,
  phone text UNIQUE DEFAULT NULL,
  phone_confirmed_at timestamptz,
  confirmed_at timestamptz GENERATED ALWAYS AS (LEAST(email_confirmed_at, phone_confirmed_at)) STORED,
  banned_until timestamptz,
  is_sso_user boolean NOT NULL DEFAULT false,
  deleted_at timestamptz,
  is_anonymous boolean NOT NULL DEFAULT false
);
CREATE UNIQUE INDEX users_email_partial_key ON auth.users (email) WHERE (is_sso_user = false);
COMMENT ON TABLE auth.users IS 'Auth: Stores user login data within a secure schema.';
CREATE TABLE auth.identities (
  provider_id text NOT NULL,
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  identity_data jsonb NOT NULL,
  provider text NOT NULL,
  last_sign_in_at timestamptz,
  created_at timestamptz,
  updated_at timestamptz,
  email text GENERATED ALWAYS AS (lower(identity_data ->> 'email')) STORED,
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  CONSTRAINT identities_provider_id_provider_unique UNIQUE (provider_id, provider)
);
CREATE TABLE auth.sessions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  created_at timestamptz,
  aal auth.aal_level
);
CREATE TABLE auth.refresh_tokens (
  instance_id uuid,
  id bigserial PRIMARY KEY,
  token varchar(255) UNIQUE,
  user_id varchar(255),
  revoked boolean,
  session_id uuid REFERENCES auth.sessions (id) ON DELETE CASCADE
);
CREATE TABLE auth.mfa_factors (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  factor_type auth.factor_type NOT NULL
);
CREATE TABLE auth.audit_log_entries (instance_id uuid, id uuid PRIMARY KEY, payload json, created_at timestamptz, ip_address varchar(64) NOT NULL DEFAULT '');
CREATE TABLE auth.schema_migrations (version varchar(255) PRIMARY KEY);
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''), (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid
$$;
CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$
  SELECT coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'))::text
$$;
CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT coalesce(nullif(current_setting('request.jwt.claim', true), ''), nullif(current_setting('request.jwt.claims', true), ''))::jsonb
$$;
ALTER TABLE auth.users ENABLE ROW LEVEL SECURITY;
RESET ROLE;

-- Supabase Storage.
SET ROLE supabase_storage_admin;
CREATE TABLE storage.buckets (
  id text PRIMARY KEY,
  name text NOT NULL,
  owner uuid,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  public boolean DEFAULT false,
  file_size_limit bigint,
  allowed_mime_types text[]
);
CREATE UNIQUE INDEX bname ON storage.buckets USING btree (name);
CREATE TABLE storage.objects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bucket_id text REFERENCES storage.buckets (id),
  name text,
  owner uuid,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  last_accessed_at timestamptz DEFAULT now(),
  metadata jsonb,
  path_tokens text[] GENERATED ALWAYS AS (string_to_array(name, '/')) STORED,
  version text,
  owner_id text,
  user_metadata jsonb
);
CREATE UNIQUE INDEX bucketid_objname ON storage.objects USING btree (bucket_id, name);
CREATE TABLE storage.migrations (id integer PRIMARY KEY, name varchar(100) UNIQUE NOT NULL, hash varchar(40) NOT NULL, executed_at timestamp DEFAULT CURRENT_TIMESTAMP);
CREATE FUNCTION storage.foldername(name text) RETURNS text[] LANGUAGE plpgsql AS $$
DECLARE _parts text[];
BEGIN
  SELECT string_to_array(name, '/') INTO _parts;
  RETURN _parts[1:array_length(_parts, 1) - 1];
END $$;
CREATE FUNCTION storage.update_updated_at_column() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$;
CREATE TRIGGER update_objects_updated_at BEFORE UPDATE ON storage.objects FOR EACH ROW EXECUTE FUNCTION storage.update_updated_at_column();
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
ALTER TABLE storage.buckets ENABLE ROW LEVEL SECURITY;
RESET ROLE;

-- Realtime.
CREATE TYPE realtime.equality_op AS ENUM ('eq', 'neq', 'lt', 'lte', 'gt', 'gte', 'in');
CREATE TYPE realtime.user_defined_filter AS (column_name text, op realtime.equality_op, value text);
CREATE TABLE realtime.schema_migrations (version bigint PRIMARY KEY, inserted_at timestamp(0));
CREATE TABLE realtime.subscription (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  subscription_id uuid NOT NULL,
  entity regclass NOT NULL,
  filters realtime.user_defined_filter[] NOT NULL DEFAULT '{}',
  created_at timestamp NOT NULL DEFAULT timezone('utc', now())
);
CREATE TABLE supabase_migrations.schema_migrations (version text PRIMARY KEY, statements text[], name text);

-- The app.
CREATE TABLE public.profiles (
  id uuid PRIMARY KEY REFERENCES auth.users (id) ON DELETE CASCADE,
  username text UNIQUE,
  avatar_url text,
  updated_at timestamptz DEFAULT now()
);
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Profiles are viewable by everyone" ON public.profiles FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "Users update their own profile" ON public.profiles FOR UPDATE TO authenticated USING ((SELECT auth.uid()) = id);
CREATE TYPE public.listing_status AS ENUM ('draft', 'live', 'sold');
CREATE TABLE public.listings (
  id uuid PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  owner uuid NOT NULL REFERENCES public.profiles (id) ON DELETE CASCADE,
  title text NOT NULL CHECK (char_length(title) > 2),
  price_cents integer NOT NULL DEFAULT 0,
  status public.listing_status NOT NULL DEFAULT 'draft',
  tags text[] NOT NULL DEFAULT '{}',
  details jsonb NOT NULL DEFAULT '{}',
  search tsvector GENERATED ALWAYS AS (to_tsvector('english', title)) STORED,
  token text DEFAULT encode(extensions.gen_random_bytes(8), 'hex'),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX listings_search ON public.listings USING gin (search);
ALTER TABLE public.listings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Owners manage their listings" ON public.listings TO authenticated USING ((SELECT auth.uid()) = owner) WITH CHECK ((SELECT auth.uid()) = owner);
CREATE TABLE public.messages (id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, listing uuid REFERENCES public.listings (id), body text NOT NULL, sent_at timestamptz DEFAULT now());
ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;
CREATE VIEW public.live_listings WITH (security_invoker = on) AS SELECT id, title, price_cents FROM public.listings WHERE status = 'live';
CREATE MATERIALIZED VIEW public.listing_counts AS SELECT owner, count(*) AS n FROM public.listings GROUP BY owner;

CREATE FUNCTION public.handle_new_user() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  INSERT INTO public.profiles (id, username) VALUES (NEW.id, NEW.raw_user_meta_data ->> 'username');
  RETURN NEW;
END $$;
CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();
CREATE FUNCTION public.notify_new_message() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM net.http_post('https://example.invalid/hook', jsonb_build_object('id', NEW.id));
  RETURN NEW;
END $$;
CREATE TRIGGER messages_hook AFTER INSERT ON public.messages FOR EACH ROW EXECUTE FUNCTION public.notify_new_message();
CREATE POLICY "Signed-in users read avatars" ON storage.objects FOR SELECT TO authenticated USING (bucket_id = 'avatars' AND (storage.foldername(name))[1] = (SELECT auth.uid())::text);

CREATE PUBLICATION supabase_realtime FOR TABLE public.messages;

GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
GRANT ALL ON ALL TABLES IN SCHEMA public TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;

-- Rows. The sign-up trigger makes each profile, as it does in a real project.
INSERT INTO auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
SELECT '00000000-0000-0000-0000-000000000000', ('00000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid, 'authenticated', 'authenticated',
       'user' || n || '@example.invalid', CASE WHEN n % 4 = 0 THEN NULL ELSE '$2a$10$' || md5(n::text) END, now(),
       '{"provider":"email","providers":["email"]}', jsonb_build_object('username', 'user' || n), now(), now()
FROM generate_series(1, 12) AS n;
INSERT INTO auth.identities (provider_id, user_id, identity_data, provider, created_at, updated_at)
SELECT id::text, id, jsonb_build_object('sub', id::text, 'email', email), 'email', now(), now() FROM auth.users;
INSERT INTO auth.schema_migrations VALUES ('20171026211738'), ('20240427152123');
INSERT INTO storage.buckets (id, name, public) VALUES ('avatars', 'avatars', true);
INSERT INTO storage.objects (bucket_id, name, metadata)
SELECT 'avatars', id::text || '/avatar.png', '{"size": 1024, "mimetype": "image/png"}' FROM auth.users LIMIT 5;
INSERT INTO public.listings (owner, title, price_cents, status, tags)
SELECT id, 'Listing for ' || username, 1000 + length(username) * 10, 'live', ARRAY['a', 'b'] FROM public.profiles;
INSERT INTO public.messages (listing, body) SELECT id, 'hello' FROM public.listings LIMIT 3;
REFRESH MATERIALIZED VIEW public.listing_counts;
INSERT INTO vault.secrets (id, name, secret) VALUES (gen_random_uuid(), 'stripe', 'not-a-real-secret');
INSERT INTO realtime.schema_migrations VALUES (20211116024918, now());
INSERT INTO supabase_migrations.schema_migrations VALUES ('20240101000000', ARRAY['select 1'], 'init');
