CREATE FUNCTION graphql.resolve(query text, variables jsonb DEFAULT '{}') RETURNS jsonb LANGUAGE sql AS $$ SELECT '{}'::jsonb $$;
CREATE TABLE graphql._field_cache (id int PRIMARY KEY);
