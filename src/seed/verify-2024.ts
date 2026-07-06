import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

async function main() {
  const election = await prisma.election.findFirst({ where: { code: "2024" } });
  if (!election) throw new Error("2024 election not found");

  const results = await prisma.constituencyResult.findMany({
    where: { electionId: election.id, electionType: "PRESIDENTIAL" },
    include: { _count: { select: { votes: true } }, constituency: { select: { name: true } } },
  });

  console.log(`Total ConstituencyResult rows: ${results.length} (expect 276 — 275 real + Ablekuma North disputed)`);

  const withZeroVotes = results.filter((r) => r._count.votes === 0);
  const withVotes = results.filter((r) => r._count.votes > 0);
  console.log(`Results WITH vote rows: ${withVotes.length}`);
  console.log(`Results with ZERO vote rows: ${withZeroVotes.length} (expect exactly 1 — Ablekuma North, status DISPUTED)`);

  console.log("\nConstituencies with zero votes:");
  for (const r of withZeroVotes) {
    console.log(`  - ${r.constituency.name} (status: ${r.status})`);
  }

  const totalVotes = await prisma.constituencyResultVote.count({
    where: { constituencyResult: { electionId: election.id, electionType: "PRESIDENTIAL" } },
  });
  console.log(`\nTotal ConstituencyResultVote rows: ${totalVotes} (expect ~3575 — 275 constituencies × 13 candidates)`);
}

main().catch(console.error).finally(() => prisma.$disconnect());
