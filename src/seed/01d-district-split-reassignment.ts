// ═══════════════════════════════════════════════════════════════════
// KOKROMOTI — Seed 01d: District Split Reassignment & Cleanup
// Closes the two loose ends left by Seed 01c:
//   1. East Akim Municipal (dissolved 2018) -> Abuakwa North / Abuakwa
//      South Municipal. Constituencies "Abuakwa North" and "Abuakwa
//      South" already match the successor districts by name exactly.
//   2. Pru (split) -> Pru East / Pru West. Constituencies "Pru East"
//      and "Pru West" already match by name exactly.
// Reassigns the affected constituency.district_id, then deletes the
// two now-orphaned parent district rows (which carry no population
// data since they no longer exist in the current 261-district register).
// Idempotent. Requires Seed 01c to have run.
// Run: npx tsx src/seed/01d-district-split-reassignment.ts
// © 2026 AIEI / Ayivi Solutions Limited
// ═══════════════════════════════════════════════════════════════════

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

interface SplitCase {
  dissolvedDistrictLegacyId: number;
  dissolvedDistrictName: string; // for logging / safety check
  reassignments: { constituencyName: string; newDistrictName: string }[];
}

const SPLITS: SplitCase[] = [
  {
    dissolvedDistrictLegacyId: 102,
    dissolvedDistrictName: "East Akim Municipal",
    reassignments: [
      { constituencyName: "Abuakwa North", newDistrictName: "Abuakwa North Municipal" },
      { constituencyName: "Abuakwa South", newDistrictName: "Abuakwa South Municipal" },
    ],
  },
  {
    dissolvedDistrictLegacyId: 163,
    dissolvedDistrictName: "Pru",
    reassignments: [
      { constituencyName: "Pru East", newDistrictName: "Pru East" },
      { constituencyName: "Pru West", newDistrictName: "Pru West" },
    ],
  },
];

async function main() {
  console.log("── Kokromoti Seed 01d: District Split Reassignment & Cleanup ──");

  for (const split of SPLITS) {
    const dissolved = await prisma.district.findFirst({
      where: { legacyDistId: split.dissolvedDistrictLegacyId },
    });

    if (!dissolved) {
      console.log(`  ${split.dissolvedDistrictName}: already absent, nothing to clean up.`);
      continue;
    }
    if (dissolved.name !== split.dissolvedDistrictName) {
      console.warn(
        `  SAFETY STOP: expected "${split.dissolvedDistrictName}" at legacyDistId ${split.dissolvedDistrictLegacyId}, found "${dissolved.name}". Skipping this split to avoid touching the wrong row.`
      );
      continue;
    }

    console.log(`\n  Resolving dissolved district: ${dissolved.name} (${dissolved.id})`);

    for (const r of split.reassignments) {
      const constituency = await prisma.constituency.findFirst({
        where: { name: r.constituencyName },
      });
      const newDistrict = await prisma.district.findFirst({
        where: { name: r.newDistrictName },
      });

      if (!constituency) {
        console.warn(`    SKIP: constituency "${r.constituencyName}" not found.`);
        continue;
      }
      if (!newDistrict) {
        console.warn(`    SKIP: successor district "${r.newDistrictName}" not found.`);
        continue;
      }

      await prisma.constituency.update({
        where: { id: constituency.id },
        data: { districtId: newDistrict.id },
      });
      console.log(`    Reassigned "${constituency.name}" -> "${newDistrict.name}"`);
    }

    // Confirm nothing still points at the dissolved district before deleting it
    const remaining = await prisma.constituency.count({ where: { districtId: dissolved.id } });
    if (remaining > 0) {
      console.warn(
        `    HOLD: ${remaining} constituency(ies) still reference "${dissolved.name}" — not deleting. Review manually.`
      );
      continue;
    }

    await prisma.district.delete({ where: { id: dissolved.id } });
    console.log(`    Deleted dissolved district record: ${dissolved.name}`);
  }

  const total = await prisma.district.count();
  const withPop = await prisma.district.count({ where: { population2021: { not: null } } });
  console.log("\n── Reconciliation ──");
  console.log(`  total districts:        ${total}  (expect 261)`);
  console.log(`  districts with pop2021:  ${withPop}  (expect 261)`);
  console.log("── Seed 01d complete ──");
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
