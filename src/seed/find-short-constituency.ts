import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

async function main() {
  const election = await prisma.election.findFirst({ where: { code: "2024" } });
  if (!election) throw new Error("2024 election not found");

  const results = await prisma.constituencyResult.findMany({
    where: { electionId: election.id, electionType: "PRESIDENTIAL" },
    include: { _count: { select: { votes: true } }, constituency: { select: { name: true } } },
  });

  const short = results.filter((r) => r._count.votes > 0 && r._count.votes !== 13);
  console.log(`Constituencies with a vote count other than 13 (excluding Ablekuma North's 0): ${short.length}`);
  for (const r of short) {
    console.log(`  - ${r.constituency.name}: ${r._count.votes} candidates`);
  }
}
main().catch(console.error).finally(() => prisma.$disconnect());
