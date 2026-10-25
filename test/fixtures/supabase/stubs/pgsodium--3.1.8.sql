CREATE TABLE pgsodium.key (id uuid PRIMARY KEY, name text);
CREATE FUNCTION pgsodium.crypto_aead_det_noncegen() RETURNS bytea LANGUAGE sql AS $$ SELECT '\x00'::bytea $$;
