// ═══════════════════════════════════════════════════════════════════
// KOKROMOTI — Seed 01g: District Lineage
// Records each current district's pre-2018 legacy name, mirroring the
// ConstituencyLineage pattern. Sourced from district_upgrade_review.csv.
// Idempotent — upserts on (districtId, era). Requires Seed 01e.
// Run: npx tsx src/seed/01g-district-lineage.ts
// © 2026 AIEI / Ayivi Solutions Limited
// ═══════════════════════════════════════════════════════════════════

import { PrismaClient } from "@prisma/client";
import * as fs from "fs";
import * as path from "path";

const prisma = new PrismaClient();
const DATA = path.join(__dirname, "..", "..", "db", "seed-data");

interface LineageRecord {
  currentName: string;
  era: string;
  historicalName: string;
  legacyDistId: number;
}

async function main() {
  console.log("── Kokromoti Seed 01g: District Lineage ──");
  const records: LineageRecord[] = JSON.parse(
    fs.readFileSync(path.join(DATA, "district_lineage.json"), "utf-8")
  );

  const districts = await prisma.district.findMany({ select: { id: true, name: true } });
  const byName = new Map(districts.map((d) => [d.name, d.id]));

  let created = 0, skipped = 0;
  for (const r of records) {
    const districtId = byName.get(r.currentName);
    if (!districtId) { skipped++; continue; }
    await prisma.districtLineage.upsert({
      where: { districtId_era: { districtId, era: r.era } },
      update: { historicalName: r.historicalName, legacyDistId: r.legacyDistId },
      create: { districtId, era: r.era, historicalName: r.historicalName, legacyDistId: r.legacyDistId },
    });
    created++;
  }

  console.log(`Created/updated: ${created} | Skipped (district not found): ${skipped}`);
  const total = await prisma.districtLineage.count();
  console.log(`\n── Reconciliation ──`);
  console.log(`  district_lineage rows: ${total} (expect ~215)`);
  console.log("── Seed 01g complete ──");
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
