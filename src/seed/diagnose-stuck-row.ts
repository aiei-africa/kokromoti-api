import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

async function main() {
  const row = await prisma.candidate.findUnique({
    where: { id: "cmr5c48rj031m7964fxu8hp45" },
    include: {
      election: { select: { code: true } },
      constituency: { select: { name: true } },
      party: { select: { abbreviation: true } },
      constituencyResultVotes: {
        include: { constituencyResult: { select: { id: true, electionId: true, constituencyId: true } } },
      },
    },
  });
  console.log(JSON.stringify(row, null, 2));

  if (row) {
    // find every other candidate for this exact election+constituency+party, placeholder or not
    const allInSlot = await prisma.candidate.findMany({
      where: { electionId: row.electionId, constituencyId: row.constituencyId, partyId: row.partyId, electionType: row.electionType },
    });
    console.log("\nAll candidates sharing this exact election+constituency+party slot:");
    console.log(JSON.stringify(allInSlot, null, 2));
  }
}

main().finally(() => prisma.$disconnect());
