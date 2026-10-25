CREATE SCHEMA net;
CREATE TABLE net.http_request_queue (id bigserial PRIMARY KEY, url text);
CREATE FUNCTION net.http_post(url text, body jsonb DEFAULT '{}') RETURNS bigint LANGUAGE sql AS $$ SELECT 1::bigint $$;
