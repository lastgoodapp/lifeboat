-- A new, empty Supabase project, as far as stock Postgres can make one, for `lastgood rebuild` to restore into
-- (cli/test/rebuild.test.mjs). Run it connected to the new database, which the test creates owned by `rebuilder`.
-- `rebuilder` plays the project's `postgres` role: not a superuser, but able to bypass row-level security (the test
-- makes it with BYPASSRLS), the database's owner, and with the Auth and Storage rights a hosted project gives it. Auth and Storage have the same columns as the dump's (source.sql), as a project
-- on the same platform version would. Supabase's own extensions are left out, because stock Postgres cannot load
-- them. Hosted rights are modelled from Supabase's documented migration and policy steps; a real new project in the
-- D17 drill is the proof.
\set ON_ERROR_STOP 1

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN NOINHERIT;
    CREATE ROLE authenticated NOLOGIN NOINHERIT;
    CREATE ROLE service_role NOLOGIN NOINHERIT BYPASSRLS;
    CREATE ROLE authenticator LOGIN NOINHERIT;
    CREATE ROLE supabase_auth_admin LOGIN NOINHERIT CREATEROLE;
    CREATE ROLE supabase_storage_admin LOGIN NOINHERIT CREATEROLE;
  END IF;
END $$;

CREATE SCHEMA extensions;
CREATE SCHEMA graphql;
CREATE SCHEMA graphql_public;
CREATE SCHEMA vault;
CREATE SCHEMA pgsodium;
CREATE SCHEMA realtime;
CREATE SCHEMA auth AUTHORIZATION supabase_auth_admin;
CREATE SCHEMA storage AUTHORIZATION supabase_storage_admin;
CREATE EXTENSION pgcrypto WITH SCHEMA extensions;
CREATE EXTENSION "uuid-ossp" WITH SCHEMA extensions;
CREATE EXTENSION pg_stat_statements WITH SCHEMA extensions;

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
CREATE TABLE auth.sessions (id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE, created_at timestamptz, aal auth.aal_level);
CREATE TABLE auth.refresh_tokens (
  instance_id uuid,
  id bigserial PRIMARY KEY,
  token varchar(255) UNIQUE,
  user_id varchar(255),
  revoked boolean,
  session_id uuid REFERENCES auth.sessions (id) ON DELETE CASCADE
);
CREATE TABLE auth.mfa_factors (id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE, factor_type auth.factor_type NOT NULL);
CREATE TABLE auth.audit_log_entries (instance_id uuid, id uuid PRIMARY KEY, payload json, created_at timestamptz, ip_address varchar(64) NOT NULL DEFAULT '');
CREATE TABLE auth.schema_migrations (version varchar(255) PRIMARY KEY);
INSERT INTO auth.schema_migrations VALUES ('20171026211738'), ('20240427152123');
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''), (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid
$$;
ALTER TABLE auth.users ENABLE ROW LEVEL SECURITY;
RESET ROLE;

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

CREATE TABLE realtime.schema_migrations (version bigint PRIMARY KEY, inserted_at timestamp(0));
CREATE PUBLICATION supabase_realtime;
ALTER PUBLICATION supabase_realtime OWNER TO rebuilder;

-- What a project's postgres role may do in Supabase's schemas: read and write Auth's and Storage's rows, add triggers
-- to them, and add policies to Storage's tables.
GRANT USAGE ON SCHEMA extensions, auth, storage, realtime TO rebuilder;
GRANT ALL ON ALL TABLES IN SCHEMA auth TO rebuilder;
GRANT ALL ON ALL SEQUENCES IN SCHEMA auth TO rebuilder;
GRANT ALL ON ALL TABLES IN SCHEMA storage TO rebuilder;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA auth, storage TO rebuilder;
GRANT supabase_storage_admin TO rebuilder;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE rebuilder IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
