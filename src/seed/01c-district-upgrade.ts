// ═══════════════════════════════════════════════════════════════════
// KOKROMOTI — Seed 01c: District Upgrade (217 legacy → 262 current MMDAs)
// Adds population2010/population2021/category to every district and
// upgrades the legacy 2012-era district set to the current register,
// per the reviewed district_upgrade_review.csv (region + name matched,
// spelling-corrected, splits and Aowin manually reconciled).
// Idempotent: upserts by (regionId, name). Requires Seed 01 to have run.
// Run: npx tsx src/seed/01c-district-upgrade.ts
// © 2026 AIEI / Ayivi Solutions Limited
// ═══════════════════════════════════════════════════════════════════

import { PrismaClient, DistrictCategory } from "@prisma/client";
import * as fs from "fs";
import * as path from "path";

const prisma = new PrismaClient();
const DATA = path.join(__dirname, "..", "..", "db", "seed-data");
const load = <T,>(f: string): T => JSON.parse(fs.readFileSync(path.join(DATA, f), "utf-8")) as T;

interface DistrictV2 {
  regionCode: string;
  name: string;
  capital: string | null;
  category: string | null;
  population2010: number | null;
  population2021: number | null;
  legacyDistId: number | null;
}

// Splits where an old district's constituencies must move to a new district.
// Format: [oldDistrictName, [newDistrictNames...]] — resolved by constituency
// name/capital proximity is NOT attempted automatically; these stay on the
// nearest matched district until a constituency-level review pass confirms
// exact reassignment. This script does not silently guess constituency links.

async function main() {
  console.log("── Kokromoti Seed 01c: District Upgrade ──");

  const regions = await prisma.region.findMany({ select: { id: true, code: true } });
  const regionByCode = new Map(regions.map((r) => [r.code, r.id]));

  const districtsV2 = load<DistrictV2[]>("districts_v2.json");
  console.log(`Loaded ${districtsV2.length} current districts from review data`);

  let updated = 0;
  let created = 0;

  for (const d of districtsV2) {
    const regionId = regionByCode.get(d.regionCode);
    if (!regionId) {
      console.warn(`  SKIP: unknown region code ${d.regionCode} for district ${d.name}`);
      continue;
    }

    const category = d.category ? (d.category as DistrictCategory) : null;

    // Match on legacyDistId first (continuity for the 214 matched districts),
    // otherwise match on (regionId, name) for the 47+1 new/split districts.
    let existing = d.legacyDistId
      ? await prisma.district.findFirst({ where: { legacyDistId: d.legacyDistId, regionId } })
      : null;

    if (!existing) {
      existing = await prisma.district.findFirst({ where: { regionId, name: d.name } });
    }

    if (existing) {
      await prisma.district.update({
        where: { id: existing.id },
        data: {
          name: d.name, // picks up spelling corrections (Akwapem -> Akuapim, etc.)
          capital: d.capital,
          category,
          population2010: d.population2010,
          population2021: d.population2021,
          legacyDistId: d.legacyDistId ?? existing.legacyDistId,
        },
      });
      updated++;
    } else {
      // New split district — needs a unique code; derive from region + sequence
      const count = await prisma.district.count({ where: { regionId } });
      const regionShort = d.regionCode.replace("/R", "");
      const code = `${regionShort}-N${String(count + 1).padStart(2, "0")}`;
      await prisma.district.create({
        data: {
          regionId,
          code,
          name: d.name,
          capital: d.capital,
          category,
          population2010: d.population2010,
          population2021: d.population2021,
          legacyDistId: d.legacyDistId,
        },
      });
      created++;
    }
  }

  console.log(`Updated: ${updated} | Created: ${created}`);

  const total = await prisma.district.count();
  const withPop = await prisma.district.count({ where: { population2021: { not: null } } });
  console.log("── Reconciliation ──");
  console.log(`  total districts:        ${total}  (expect 261)`);
  console.log(`  districts with pop2021:  ${withPop}`);
  console.log("── Seed 01c complete ──");
  console.log("");
  console.log("NOTE: constituency.district_id reassignment for split districts");
  console.log("(e.g. East Akim -> Abuakwa North/South) is NOT done by this script.");
  console.log("That requires a separate, reviewed constituency-to-district mapping");
  console.log("pass, since it touches live constituency records.");
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
