import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

async function main() {
  const election = await prisma.election.findFirst({ where: { code: "2024" } });
  if (!election) throw new Error("2024 election not found");

  const results = await prisma.constituencyResult.findMany({
    where: { electionId: election.id, electionType: "PARLIAMENTARY" },
    include: { votes: { include: { candidate: { include: { party: true } } } } },
  });

  console.log(`Total ConstituencyResult rows: ${results.length} (expect 276)`);

  const seats: Record<string, number> = {};
  let noWinner = 0;
  for (const r of results) {
    if (!r.votes.length) { noWinner++; continue; }
    const winner = r.votes.reduce((a, b) => (b.votes > a.votes ? b : a));
    const abbrev = winner.candidate.party?.abbreviation ?? "IND";
    seats[abbrev] = (seats[abbrev] ?? 0) + 1;
  }

  console.log(`Constituencies with no votes at all: ${noWinner} (expect 0)`);
  console.log("\nSeat count by party:");
  for (const [party, count] of Object.entries(seats).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${party}: ${count}`);
  }

  // spot-check the specific fix
  const asutifi = await prisma.constituencyResult.findFirst({
    where: { electionId: election.id, electionType: "PARLIAMENTARY", constituency: { name: "Asutifi North" } },
    include: { votes: { include: { candidate: true } } },
  });
  console.log("\nAsutifi North candidates (spot-check the NDP->NDC fix):");
  for (const v of asutifi?.votes ?? []) {
    console.log(`  ${v.candidate.fullName} — partyId=${v.candidate.partyId} — votes=${v.votes}`);
  }
}
main().catch(console.error).finally(() => prisma.$disconnect());
