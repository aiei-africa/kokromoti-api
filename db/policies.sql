-- ═══════════════════════════════════════════════════════════════════
-- KOKROMOTI — RLS Policies & Realtime Publication
-- Run once in Supabase SQL Editor against kokromoti-prod.
-- Model: RLS on everything, default deny. Anon/authenticated get
-- SELECT on public-facing tables only. Everything else is reachable
-- solely through the API (service_role bypasses RLS by design).
-- © 2026 AIEI / Ayivi Solutions Limited
-- ═══════════════════════════════════════════════════════════════════

-- 1 ── Schema access
GRANT USAGE ON SCHEMA kokromoti TO anon, authenticated, service_role;
GRANT ALL ON ALL TABLES IN SCHEMA kokromoti TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA kokromoti
  GRANT ALL ON TABLES TO service_role;

-- 2 ── Enable RLS on all 39 tables
DO $$
DECLARE t text;
BEGIN
  FOR t IN
    SELECT tablename FROM pg_tables WHERE schemaname = 'kokromoti'
  LOOP
    EXECUTE format('ALTER TABLE kokromoti.%I ENABLE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;

-- 3 ── Public read layer: geography, elections, parties, candidates,
--      all result levels, events, commentary, news, plan catalogue
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'countries','regions','districts','constituencies',
    'constituency_lineage','constituency_boundaries','polling_stations',
    'elections','parties','candidates','running_mates',
    'station_results','station_result_votes',
    'constituency_results','constituency_result_votes',
    'regional_results','regional_result_votes',
    'national_results','national_result_votes',
    'election_events','commentary_items','news_items',
    'subscription_plans'
  ]
  LOOP
    EXECUTE format('GRANT SELECT ON kokromoti.%I TO anon, authenticated', t);
    EXECUTE format(
      'CREATE POLICY %I ON kokromoti.%I FOR SELECT TO anon, authenticated USING (true)',
      'public_read_' || t, t
    );
  END LOOP;
END $$;

-- 4 ── Private tables (users, agents, transmissions, duress_events,
--      subscriptions, payments, favourites, notifications, push tokens,
--      api clients/keys/logs, audit, reconciliation, auth sessions):
--      RLS enabled, NO policies, NO anon grants = fully closed.
--      The Express API is the only gateway, via service_role.

-- 5 ── Realtime publication: live result + event broadcast
ALTER PUBLICATION supabase_realtime
  ADD TABLE kokromoti.station_results, kokromoti.election_events;
