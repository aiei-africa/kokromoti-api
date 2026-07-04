import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

async function main() {
  const stuckId = "cmr5c48rj031m7964fxu8hp45"; // legacyCandId 5282, "Joseph Baah", Atiwa
  const row = await prisma.candidate.findUnique({ where: { id: stuckId } });
  if (!row) { console.log("Row not found — already resolved."); return; }

  // Party lookup: this row should be CPP, not the leftover wrong NPP link
  const cpp = await prisma.party.findFirst({ where: { abbreviation: "CPP" } });
  if (!cpp) throw new Error("CPP party not found");

  console.log("Writing correct data for the stuck row (expecting this to collide with its sibling)...");
  try {
    await prisma.candidate.update({
      where: { id: stuckId },
      data: { fullName: "Joseph Baah", partyId: cpp.id, age: 56 },
    });
    console.log("Updated without collision — no sibling existed. Nothing further to merge.");
  } catch (e) {
    console.log("Collided as expected — this confirms the genuine duplicate. Merging into sibling...");
    const sibling = await prisma.candidate.findFirst({
      where: {
        electionId: row.electionId, electionType: "PARLIAMENTARY",
        constituencyId: row.constituencyId, partyId: cpp.id, fullName: "Joseph Baah",
        NOT: { id: stuckId },
      },
    });
    if (!sibling) { console.error("No sibling found despite collision — needs manual review."); return; }
    console.log(`Sibling found: ${sibling.id}`);

    const votes = await prisma.constituencyResultVote.findMany({ where: { candidateId: stuckId } });
    for (const v of votes) {
      const existing = await prisma.constituencyResultVote.findFirst({
        where: { constituencyResultId: v.constituencyResultId, candidateId: sibling.id },
      });
      if (existing) {
        console.log("  Sibling already has a vote for this result — dropping the duplicate vote row.");
        await prisma.constituencyResultVote.delete({ where: { id: v.id } });
      } else {
        await prisma.constituencyResultVote.update({ where: { id: v.id }, data: { candidateId: sibling.id } });
        console.log("  Reassigned vote to sibling.");
      }
    }
    await prisma.candidate.delete({ where: { id: stuckId } });
    console.log("Deleted the duplicate row.");
  }

  const remaining = await prisma.candidate.count({ where: { fullName: { startsWith: "__TMP__" } } });
  console.log(`\nRemaining __TMP__ rows: ${remaining} (expect 0)`);
}

main().finally(() => prisma.$disconnect());
