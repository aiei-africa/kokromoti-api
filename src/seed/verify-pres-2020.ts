import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

async function main() {
  const election = await prisma.election.findFirst({ where: { code: "2020" } });
  if (!election) throw new Error("2020 election not found");

  const results = await prisma.constituencyResult.findMany({
    where: { electionId: election.id, electionType: "PRESIDENTIAL" },
    include: { votes: { include: { candidate: true } } },
  });
  console.log(`Total ConstituencyResult rows: ${results.length} (expect 275)`);

  const withZeroVotes = results.filter((r) => r.votes.length === 0);
  console.log(`Results with ZERO vote rows: ${withZeroVotes.length} (expect 0)`);

  const totalVotes = await prisma.constituencyResultVote.count({
    where: { constituencyResult: { electionId: election.id, electionType: "PRESIDENTIAL" } },
  });
  console.log(`Total ConstituencyResultVote rows: ${totalVotes} (expect 3300)`);

  // national rollup, independently computed from what's actually stored
  const national: Record<string, number> = {};
  for (const r of results) {
    for (const v of r.votes) {
      national[v.candidate.fullName] = (national[v.candidate.fullName] ?? 0) + v.votes;
    }
  }
  const grandTotal = Object.values(national).reduce((a, b) => a + b, 0);
  console.log("\nNational rollup (independently computed from stored data):");
  for (const [name, votes] of Object.entries(national).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${name.padEnd(35)} ${votes.toLocaleString().padStart(10)}  ${((votes / grandTotal) * 100).toFixed(2)}%`);
  }
  console.log(`  Total: ${grandTotal.toLocaleString()}`);

  const withRegisteredVoters = results.filter((r) => r.registeredVoters != null).length;
  console.log(`\nResults with registeredVoters populated: ${withRegisteredVoters}/275`);
}
main().catch(console.error).finally(() => prisma.$disconnect());
