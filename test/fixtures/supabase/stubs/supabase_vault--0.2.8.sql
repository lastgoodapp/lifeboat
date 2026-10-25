CREATE TABLE vault.secrets (id uuid PRIMARY KEY, name text, secret text NOT NULL, created_at timestamptz DEFAULT now());
SELECT pg_catalog.pg_extension_config_dump('vault.secrets', '');
CREATE VIEW vault.decrypted_secrets AS SELECT id, name, secret AS decrypted_secret FROM vault.secrets;
