// ═══════════════════════════════════════════════════════════════════
// KOKROMOTI — Seed 04b: Clean Up Stuck Placeholder Rows
//
// Seed 04's Phase B fallback correctly SKIPPED writing corrected data for
// genuine source duplicates (two legacyCandIds sharing the same election
// + constituency + party + name — e.g. "2000: Joseph Baah"), but it never
// reverted those rows out of their temporary "__TMP__<id>" placeholder
// name. This script finds any remaining __TMP__ rows, reassigns any votes
// already attached to them onto their correctly-named sibling candidate
// (same election + constituency + party), then deletes the now-redundant
// duplicate row. If a __TMP__ row has no sibling and no votes, it is
// deleted outright as a bare duplicate entry with nothing depending on it.
//
// Run: npx tsx src/seed/04b-cleanup-placeholders.ts
// © 2026 AIEI / Ayivi Solutions Limited
// ═══════════════════════════════════════════════════════════════════

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  console.log("── Kokromoti Seed 04b: Clean Up Stuck Placeholder Rows ──");

  const stuck = await prisma.candidate.findMany({
    where: { fullName: { startsWith: "__TMP__" } },
    select: { id: true, electionId: true, electionType: true, constituencyId: true, partyId: true, fullName: true },
  });
  console.log(`Found ${stuck.length} stuck placeholder rows.`);

  for (const row of stuck) {
    console.log(`\n  Row ${row.id} (${row.fullName})`);

    // Find the correctly-named sibling: same election + type + constituency + party
    const sibling = await prisma.candidate.findFirst({
      where: {
        electionId: row.electionId,
        electionType: row.electionType,
        constituencyId: row.constituencyId,
        partyId: row.partyId,
        NOT: { id: row.id },
        fullName: { not: { startsWith: "__TMP__" } },
      },
    });

    if (sibling) {
      console.log(`    Sibling found: "${sibling.fullName}" (${sibling.id})`);
      // Reassign any votes pointing at the stuck row onto the sibling
      const votes = await prisma.constituencyResultVote.findMany({ where: { candidateId: row.id } });
      for (const v of votes) {
        const existingSiblingVote = await prisma.constituencyResultVote.findFirst({
          where: { constituencyResultId: v.constituencyResultId, candidateId: sibling.id },
        });
        if (existingSiblingVote) {
          console.log(`    Vote already exists on sibling for this result — dropping duplicate vote row.`);
          await prisma.constituencyResultVote.delete({ where: { id: v.id } });
        } else {
          await prisma.constituencyResultVote.update({ where: { id: v.id }, data: { candidateId: sibling.id } });
          console.log(`    Reassigned 1 vote row to sibling.`);
        }
      }
    } else {
      console.log(`    No sibling found — checking for orphaned votes...`);
      const voteCount = await prisma.constituencyResultVote.count({ where: { candidateId: row.id } });
      if (voteCount > 0) {
        console.warn(`    WARN: ${voteCount} votes reference this row with no sibling to reassign to. Leaving in place — manual review needed.`);
        continue;
      }
    }

    await prisma.candidate.delete({ where: { id: row.id } });
    console.log(`    Deleted duplicate candidate row.`);
  }

  const remaining = await prisma.candidate.count({ where: { fullName: { startsWith: "__TMP__" } } });
  console.log(`\n── Reconciliation ──`);
  console.log(`  remaining __TMP__ rows: ${remaining} (expect 0)`);
  console.log("── Seed 04b complete ──");
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
