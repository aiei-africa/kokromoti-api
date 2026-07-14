import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

async function main() {
  const election = await prisma.election.findFirst({ where: { code: "2016" } });
  if (!election) throw new Error("2016 election not found");

  const results = await prisma.constituencyResult.findMany({
    where: { electionId: election.id, electionType: "PARLIAMENTARY" },
    include: { votes: { include: { candidate: { include: { party: true } } } }, constituency: { select: { name: true } } },
  });
  console.log(`Total ConstituencyResult rows: ${results.length} (expect 275)`);

  const withZeroVotes = results.filter((r) => r.votes.length === 0);
  console.log(`Results with ZERO vote rows: ${withZeroVotes.length} (expect 0)`);

  // real, independently-computed national seat count
  const seats: Record<string, number> = {};
  for (const r of results) {
    const winner = r.votes.reduce((a, b) => (b.votes > a.votes ? b : a));
    const abbrev = winner.candidate.party?.abbreviation ?? "IND";
    seats[abbrev] = (seats[abbrev] ?? 0) + 1;
  }
  console.log("\nNational seat count (expect NPP 169, NDC 106):");
  for (const [p, n] of Object.entries(seats).sort((a, b) => b[1] - a[1])) console.log(`  ${p}: ${n}`);

  // direct check on both corrected constituencies
  for (const name of ["Okaikwei South", "Akrofuom"]) {
    const r = results.find((res) => res.constituency.name === name);
    console.log(`\n=== ${name} ===`);
    if (!r) { console.log("  NOT FOUND"); continue; }
    for (const v of r.votes.sort((a, b) => b.votes - a.votes)) {
      console.log(`  ${v.candidate.fullName.padEnd(30)} ${(v.candidate.party?.abbreviation ?? "IND").padEnd(5)} votes=${v.votes}`);
    }
  }
}
main().catch(console.error).finally(() => prisma.$disconnect());
