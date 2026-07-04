// ═══════════════════════════════════════════════════════════════════
// KOKROMOTI — Seed 01f: Archive Legacy Stations, Load Real EC 2024 Register
// Moves the existing 26,002 legacy (2012-era) PollingStation rows into
// PollingStationArchive (frozen, for historical reference only), then
// loads the real 40,647-station EC 2024 register into PollingStation.
// ecDistrictName carries the EC's own district label verbatim — it is
// NOT the same as the 261-MMDA administrative District; EC, police, and
// ECG each demarcate districts differently, and this preserves EC's as-is.
// GPS (latitude/longitude) intentionally left null — a separate community
// gazetteer pass will backfill these later.
// Batched via createMany for performance. Requires Seed 01/01c/01d/01e.
// Run: npx tsx src/seed/01f-ec2024-stations.ts
// © 2026 AIEI / Ayivi Solutions Limited
// ═══════════════════════════════════════════════════════════════════

import { PrismaClient } from "@prisma/client";
import * as fs from "fs";
import * as path from "path";

const prisma = new PrismaClient();
const DATA = path.join(__dirname, "..", "..", "db", "seed-data");

interface EcStation {
  code: string;
  name: string;
  const: string;
  district: string;
  region: string;
  seededConstName: string;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function main() {
  console.log("── Kokromoti Seed 01f: EC 2024 Polling Station Register ──");

  // ── Step 1: Archive existing legacy stations
  const legacy = await prisma.pollingStation.findMany({
    select: { constituencyId: true, code: true, name: true, eaCode: true, registeredVoters: true, legacyPid: true },
  });
  console.log(`Archiving ${legacy.length} legacy stations...`);

  let archived = 0;
  for (const batch of chunk(legacy, 1000)) {
    const res = await prisma.pollingStationArchive.createMany({
      data: batch.map((s) => ({ ...s, era: "2012-2016 legacy" })),
      skipDuplicates: true,
    });
    archived += res.count;
    process.stdout.write(`\r  archived: ${archived}/${legacy.length}`);
  }
  console.log();

  const deleted = await prisma.pollingStation.deleteMany({});
  console.log(`Cleared ${deleted.count} legacy rows from live polling_stations table.`);

  // ── Step 2: Load the real EC 2024 register
  const ecStations: EcStation[] = JSON.parse(
    fs.readFileSync(path.join(DATA, "ec2024_stations_final.json"), "utf-8")
  );
  console.log(`\nLoading ${ecStations.length} EC 2024 stations...`);

  const constituencies = await prisma.constituency.findMany({ select: { id: true, name: true } });
  const constByName = new Map(constituencies.map((c) => [c.name, c.id]));

  const stationRows: {
    constituencyId: string; code: string; name: string; ecDistrictName: string; isActive: true;
  }[] = [];
  let skippedNoConst = 0;

  for (const s of ecStations) {
    const constituencyId = constByName.get(s.seededConstName);
    if (!constituencyId) { skippedNoConst++; continue; }
    stationRows.push({
      constituencyId, code: s.code, name: s.name, ecDistrictName: s.district, isActive: true,
    });
  }

  let inserted = 0;
  for (const batch of chunk(stationRows, 1000)) {
    const res = await prisma.pollingStation.createMany({ data: batch, skipDuplicates: true });
    inserted += res.count;
    process.stdout.write(`\r  loaded: ${inserted}/${stationRows.length}`);
  }
  console.log();

  if (skippedNoConst) console.warn(`  WARN: ${skippedNoConst} stations skipped — constituency not found`);

  // ── Reconciliation
  const finalCount = await prisma.pollingStation.count();
  const archiveCount = await prisma.pollingStationArchive.count();
  const distinctConsts = await prisma.pollingStation.groupBy({ by: ["constituencyId"] });

  console.log("\n── Reconciliation ──");
  console.log(`  live polling_stations:     ${finalCount}  (expect 40647)`);
  console.log(`  polling_station_archive:   ${archiveCount}  (expect 26002)`);
  console.log(`  constituencies with stations: ${distinctConsts.length}  (expect 276)`);
  console.log("── Seed 01f complete ──");
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
