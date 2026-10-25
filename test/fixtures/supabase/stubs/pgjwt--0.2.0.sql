CREATE FUNCTION @extschema@.sign(payload json, secret text, algorithm text DEFAULT 'HS256') RETURNS text LANGUAGE sql AS $$ SELECT 'x' $$;
