-- Run these first to see whether these tables already have data.
-- Both seed scripts use upsert, so they're safe either way — but worth
-- knowing what you're looking at before running anything.

SELECT COUNT(*) AS boundary_rows FROM kokromoti.constituency_boundaries;
SELECT COUNT(*) AS regional_rows FROM kokromoti.regional_results;
SELECT COUNT(*) AS national_rows FROM kokromoti.national_results;

-- If boundary_rows = 276, boundaries are already fully seeded — running
-- 13-constituency-boundaries.ts again will just update them to match
-- today's verified geometry (version number will increment).
--
-- If regional_rows = 128 (16 regions x 8 elections) and national_rows = 8,
-- those are already fully seeded too.
