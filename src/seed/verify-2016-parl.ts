import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

async function main() {
  const election = await prisma.election.findFirst({ where: { code: "2016" } });
  if (!election) throw new Error("2016 election not found");
  console.log(`Election: ${election.name} (${election.id})`);

  const count = await prisma.constituencyResult.count({
    where: { electionId: election.id, electionType: "PARLIAMENTARY" },
  });
  console.log(`ConstituencyResult rows for 2016 PARLIAMENTARY: ${count} (out of 275 real constituencies that existed in 2016)`);

  const withVotes = await prisma.constituencyResult.findMany({
    where: { electionId: election.id, electionType: "PARLIAMENTARY" },
    include: { _count: { select: { votes: true } } },
  });
  const zeroVotes = withVotes.filter((r) => r._count.votes === 0).length;
  console.log(`Of those, with zero vote rows: ${zeroVotes}`);

  // which constituencies HAVE it vs which are missing, by region, to see the shape of the gap
  const allConstituencies = await prisma.constituency.findMany({
    where: { name: { not: "Guan" } }, // didn't exist in 2016 either
    select: { id: true, name: true, region: { select: { shortName: true } } },
  });
  const haveResultIds = new Set(withVotes.map((r) => r.constituencyId));
  const missing = allConstituencies.filter((c) => !haveResultIds.has(c.id));

  console.log(`\nMissing constituencies: ${missing.length}`);
  const byRegion: Record<string, number> = {};
  for (const m of missing) byRegion[m.region.shortName] = (byRegion[m.region.shortName] ?? 0) + 1;
  console.log("Missing, by region:");
  for (const [region, n] of Object.entries(byRegion).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${region}: ${n}`);
  }
}
main().catch(console.error).finally(() => prisma.$disconnect());
