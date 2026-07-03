// ═══════════════════════════════════════════════════════════════════
// KOKROMOTI — Seed 01: Geography
// Ghana → 16 regions → 217 districts → 276 constituencies → 26,002 stations
// Source: legacy 1992–2016 MS SQL exports, region-remapped per approved
// review tables (region_remap.csv, district_remap.csv).
// Idempotent: upserts by legacy anchors / unique keys; safe to re-run.
// Run: npx tsx src/seed/01-geography.ts
// © 2026 AIEI / Ayivi Solutions Limited
// ═══════════════════════════════════════════════════════════════════

import { PrismaClient } from "@prisma/client";
import * as fs from "fs";
import * as path from "path";

const prisma = new PrismaClient();
const DATA = path.join(__dirname, "..", "..", "db", "seed-data");

function load<T>(file: string): T {
  return JSON.parse(fs.readFileSync(path.join(DATA, file), "utf-8")) as T;
}

interface RegionSeed { code: string; name: string; shortName: string; capital: string; legacyRegionId: number; }
interface DistrictSeed { legacyDistId: number; code: string; name: string; capital: string | null; regionCode: string; }
interface ConstituencySeed {
  legacyConstId: number; ecCode: string; name: string; capital: string | null;
  legacyDistId: number | null; regionCode: string; stationCount: number | null;
  facts: string | null; longitude: string | null; latitude: string | null;
}
interface StationSeed {
  legacyPid: number; code: string; name: string;
  legacyConstId: number; eaCode: string | null; registeredVoters: number | null;
}

async function main() {
  console.log("── Kokromoti Seed 01: Geography ──");

  // 1 ── Country
  const ghana = await prisma.country.upsert({
    where: { code: "GH" },
    update: {},
    create: { code: "GH", name: "Ghana" },
  });
  console.log(`Country: Ghana (${ghana.id})`);

  // 2 ── Regions (16)
  const regions = load<RegionSeed[]>("regions.json");
  const regionByCode = new Map<string, string>();
  for (const r of regions) {
    const rec = await prisma.region.upsert({
      where: { countryId_code: { countryId: ghana.id, code: r.code } },
      update: { name: r.name, shortName: r.shortName, capital: r.capital, legacyRegionId: r.legacyRegionId },
      create: { countryId: ghana.id, ...r },
    });
    regionByCode.set(r.code, rec.id);
  }
  console.log(`Regions: ${regionByCode.size}`);

  // 3 ── Districts (217 incl. Guan District)
  const districts = load<DistrictSeed[]>("districts.json");
  const districtByLegacy = new Map<number, string>();
  for (const d of districts) {
    const regionId = regionByCode.get(d.regionCode)!;
    const rec = await prisma.district.upsert({
      where: { regionId_code: { regionId, code: d.code } },
      update: { name: d.name, capital: d.capital, legacyDistId: d.legacyDistId },
      create: { regionId, code: d.code, name: d.name, capital: d.capital, legacyDistId: d.legacyDistId },
    });
    districtByLegacy.set(d.legacyDistId, rec.id);
  }
  console.log(`Districts: ${districtByLegacy.size}`);

  // 4 ── Constituencies (276 incl. Guan)
  const consts = load<ConstituencySeed[]>("constituencies.json");
  const constByLegacy = new Map<number, string>();
  for (const c of consts) {
    const rec = await prisma.constituency.upsert({
      where: { countryId_ecCode: { countryId: ghana.id, ecCode: c.ecCode } },
      update: {
        name: c.name, capital: c.capital, facts: c.facts,
        stationCount: c.stationCount, legacyConstId: c.legacyConstId,
      },
      create: {
        countryId: ghana.id,
        regionId: regionByCode.get(c.regionCode)!,
        districtId: c.legacyDistId ? districtByLegacy.get(c.legacyDistId) ?? null : null,
        ecCode: c.ecCode, name: c.name, capital: c.capital,
        latitude: c.latitude, longitude: c.longitude,
        stationCount: c.stationCount, facts: c.facts,
        legacyConstId: c.legacyConstId,
      },
    });
    constByLegacy.set(c.legacyConstId, rec.id);
  }
  console.log(`Constituencies: ${constByLegacy.size}`);

  // 5 ── Polling stations (26,002) — chunked createMany, skipDuplicates
  const stations = load<StationSeed[]>("polling_stations.json");
  let inserted = 0;
  const CHUNK = 1000;
  for (let i = 0; i < stations.length; i += CHUNK) {
    const batch = stations.slice(i, i + CHUNK).map((s) => ({
      constituencyId: constByLegacy.get(s.legacyConstId)!,
      code: s.code, name: s.name, eaCode: s.eaCode,
      registeredVoters: s.registeredVoters, legacyPid: s.legacyPid,
    }));
    const res = await prisma.pollingStation.createMany({ data: batch, skipDuplicates: true });
    inserted += res.count;
    process.stdout.write(`\rStations: ${Math.min(i + CHUNK, stations.length)}/${stations.length} processed (${inserted} inserted)`);
  }
  console.log();

  // 6 ── Reconciliation report
  const counts = {
    regions: await prisma.region.count(),
    districts: await prisma.district.count(),
    constituencies: await prisma.constituency.count(),
    pollingStations: await prisma.pollingStation.count(),
  };
  console.log("── Reconciliation ──");
  console.log(`  regions:        ${counts.regions}  (expect 16)`);
  console.log(`  districts:      ${counts.districts}  (expect 217)`);
  console.log(`  constituencies: ${counts.constituencies}  (expect 276)`);
  console.log(`  stations:       ${counts.pollingStations}  (expect 26002)`);
  const perRegion = await prisma.constituency.groupBy({ by: ["regionId"], _count: true });
  const regionNames = await prisma.region.findMany({ select: { id: true, shortName: true } });
  const nameById = new Map(regionNames.map((r) => [r.id, r.shortName]));
  for (const g of perRegion.sort((a, b) => (nameById.get(a.regionId)! < nameById.get(b.regionId)! ? -1 : 1))) {
    console.log(`    ${nameById.get(g.regionId)}: ${g._count}`);
  }
  console.log("── Seed 01 complete ──");
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
