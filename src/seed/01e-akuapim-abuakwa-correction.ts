// ═══════════════════════════════════════════════════════════════════
// KOKROMOTI — Seed 01e: Corrective Patch (Akuapim/Abuakwa data error)
// Fixes a genuine bug from an earlier review-data correction that:
//   - created duplicate rows for "Akuapim North Municipal" and
//     "Akuapim South" (one linked to legacy ids 89/90, one orphaned)
//   - never created "Abuakwa North Municipal" / "Abuakwa South
//     Municipal" at all, leaving East Akim Municipal (dissolved 2018)
//     stuck in the table with its two constituencies still attached
// This script: removes the orphaned Akuapim duplicates, creates the
// two missing Abuakwa districts, reassigns the Abuakwa North/South
// constituencies to them, and retires the dissolved East Akim parent.
// Idempotent — safe to re-run. Run after Seed 01d.
// Run: npx tsx src/seed/01e-akuapim-abuakwa-correction.ts
// © 2026 AIEI / Ayivi Solutions Limited
// ═══════════════════════════════════════════════════════════════════

import { PrismaClient, DistrictCategory } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  console.log("── Kokromoti Seed 01e: Akuapim/Abuakwa Correction ──");

  // 1 ── Remove orphaned duplicate Akuapim rows (no legacyDistId — the
  //      real ones carry legacyDistId 89/90 from the original upgrade)
  for (const name of ["Akuapim North Municipal", "Akuapim South"]) {
    const dupes = await prisma.district.findMany({ where: { name, legacyDistId: null } });
    for (const d of dupes) {
      await prisma.district.delete({ where: { id: d.id } });
      console.log(`  Deleted orphaned duplicate: ${name} (${d.id})`);
    }
    if (dupes.length === 0) console.log(`  No orphaned duplicate found for ${name} — already clean.`);
  }

  // 2 ── Create the two missing Abuakwa districts (Eastern region)
  const eastern = await prisma.region.findFirst({ where: { code: "E/R" } });
  if (!eastern) throw new Error("Eastern region not found — cannot proceed.");

  const toCreate = [
    { name: "Abuakwa North Municipal", capital: "Kukurantumi", population2010: 73580, population2021: 97450 },
    { name: "Abuakwa South Municipal", capital: "Kibi", population2010: 85263, population2021: 102430 },
  ];

  const created: Record<string, string> = {};
  for (const d of toCreate) {
    let district = await prisma.district.findFirst({ where: { name: d.name, regionId: eastern.id } });
    if (!district) {
      const count = await prisma.district.count({ where: { regionId: eastern.id } });
      district = await prisma.district.create({
        data: {
          regionId: eastern.id,
          code: `E-N${String(count + 1).padStart(2, "0")}`,
          name: d.name,
          capital: d.capital,
          category: DistrictCategory.MUNICIPAL,
          population2010: d.population2010,
          population2021: d.population2021,
        },
      });
      console.log(`  Created: ${d.name} (${district.id})`);
    } else {
      console.log(`  Already exists: ${d.name} — skipping create.`);
    }
    created[d.name] = district.id;
  }

  // 3 ── Reassign the two constituencies
  const reassignments = [
    { constituencyName: "Abuakwa North", newDistrictName: "Abuakwa North Municipal" },
    { constituencyName: "Abuakwa South", newDistrictName: "Abuakwa South Municipal" },
  ];
  for (const r of reassignments) {
    const constituency = await prisma.constituency.findFirst({ where: { name: r.constituencyName } });
    if (!constituency) { console.warn(`  SKIP: constituency "${r.constituencyName}" not found.`); continue; }
    await prisma.constituency.update({
      where: { id: constituency.id },
      data: { districtId: created[r.newDistrictName] },
    });
    console.log(`  Reassigned "${r.constituencyName}" -> "${r.newDistrictName}"`);
  }

  // 4 ── Retire the dissolved East Akim Municipal parent, now that
  //      nothing should still reference it
  const eastAkim = await prisma.district.findFirst({ where: { legacyDistId: 102 } });
  if (eastAkim) {
    const remaining = await prisma.constituency.count({ where: { districtId: eastAkim.id } });
    if (remaining === 0) {
      await prisma.district.delete({ where: { id: eastAkim.id } });
      console.log(`  Deleted dissolved district record: East Akim Municipal`);
    } else {
      console.warn(`  HOLD: ${remaining} constituency(ies) still reference East Akim Municipal — not deleting.`);
    }
  } else {
    console.log("  East Akim Municipal already absent — nothing to clean up.");
  }

  const total = await prisma.district.count();
  const withPop = await prisma.district.count({ where: { population2021: { not: null } } });
  console.log("\n── Reconciliation ──");
  console.log(`  total districts:        ${total}  (expect 261)`);
  console.log(`  districts with pop2021:  ${withPop}  (expect 261)`);
  console.log("── Seed 01e complete ──");
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
