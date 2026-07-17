import { prisma } from "../lib/prisma";
import fs from "fs";
import path from "path";

// Seeds ConstituencyBoundary from real geometry reconstructed from GM's own
// ArcGIS-digitized shapefile data (via the legacy Tableau/Firebird pipeline —
// tblMapFeatures.csv + tblMapPoints.csv), spatially verified against
// reference points (275/275 clean match, avg error ~3.6km). Every
// constituency except Guan carries `source: LEGACY_MAPPOINTS`, matching the
// provenance this model was already designed to hold.
//
// Guan is the one exception: it's the 276th constituency, added for the
// 2024 election, so it postdates the legacy shapefile entirely and has no
// `legacyConstId` to join on. Its shape is `source: EC_2024_APPROXIMATED` —
// the northernmost ~23% of Hohoe constituency, cut geometrically and
// carried forward per GM's own specified methodology, not claimed as a
// precise official boundary. Guan's election data itself is fully real
// (EC_OFFICIAL), only the polygon is an approximation.
//
// Upsert-keyed on `constituencyId` (the model's own @unique constraint), so
// this is safe to run whether the table is empty or already has prior data —
// it updates existing rows to match this verified geometry rather than
// risking duplicates.

interface BoundaryRow {
  legacyConstId: number | null;
  name: string;
  geometry: unknown;
  source: string;
}

async function main() {
  const dataPath = path.join(__dirname, "../../db/seed-data/constituency_boundaries.json");
  const rows: BoundaryRow[] = JSON.parse(fs.readFileSync(dataPath, "utf-8"));
  console.log(`Starting: ${rows.length} constituencies to process. This does one DB lookup + one upsert per row (sequential, over the network) — expect real time to pass. Progress logs every 25 rows below; if you see nothing move for several minutes with no progress line, that's the actual signal something's wrong, not just "it's slow".`);

  let updated = 0;
  let skipped: string[] = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const constituency = row.legacyConstId != null
      ? await prisma.constituency.findFirst({ where: { legacyConstId: row.legacyConstId } })
      : await prisma.constituency.findFirst({ where: { name: row.name } });

    if (!constituency) {
      skipped.push(`${row.name} (legacyConstId=${row.legacyConstId})`);
      continue;
    }

    await prisma.constituencyBoundary.upsert({
      where: { constituencyId: constituency.id },
      update: { geometry: row.geometry as any, source: row.source, version: { increment: 1 } },
      create: { constituencyId: constituency.id, geometry: row.geometry as any, source: row.source },
    });
    updated++;

    if ((i + 1) % 25 === 0 || i === rows.length - 1) {
      console.log(`  ...${i + 1}/${rows.length} processed (${updated} upserted, ${skipped.length} skipped so far)`);
    }
  }

  console.log(`ConstituencyBoundary: ${updated} upserted, ${skipped.length} skipped (no matching Constituency record).`);
  if (skipped.length) {
    console.log("Skipped:", skipped);
    console.log("This means those constituencies don't exist in the Constituency table yet — check the base constituency seed ran first.");
  }
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
