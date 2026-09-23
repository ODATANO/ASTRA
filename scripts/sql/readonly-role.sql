-- Read-only role for ODATANO ASTRA on a *source* database (ODATANO or NIGHTGATE).
-- Run inside the source Postgres container, once per source (psql, needs -v pw):
--
--   docker exec -i odatano-postgres   psql -U odatano   -d odatano   -v pw="'<password>'" < scripts/sql/readonly-role.sql
--   docker exec -i nightgate-postgres psql -U nightgate -d nightgate -v pw="'<password>'" < scripts/sql/readonly-role.sql
--
-- The role can only SELECT. Tables the source's `cds deploy` creates later are
-- covered by the default-privileges clause, so upgrades of ODATANO / NIGHTGATE
-- do not need a re-run.

-- create or refresh the role (psql variables are not expanded inside DO blocks → \gexec)
SELECT format('CREATE ROLE astra_ro LOGIN PASSWORD %L', :pw)
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'astra_ro') \gexec
SELECT format('ALTER ROLE astra_ro WITH LOGIN PASSWORD %L', :pw)
 WHERE EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'astra_ro') \gexec

SELECT format('GRANT CONNECT ON DATABASE %I TO astra_ro', current_database()) \gexec
GRANT USAGE ON SCHEMA public TO astra_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO astra_ro;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO astra_ro;
-- Belt and braces: never let this role write, even if someone widens a grant later.
ALTER ROLE astra_ro SET default_transaction_read_only = on;
ALTER ROLE astra_ro SET statement_timeout = '120s';
