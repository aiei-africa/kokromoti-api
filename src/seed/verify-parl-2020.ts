import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

async function main() {
  const election = await prisma.election.findFirst({ where: { code: "2020" } });
  console.log("Election lookup for code '2020':", election ? `FOUND — id=${election.id}, name=${election.name}` : "NOT FOUND");
  if (!election) return;

  const count = await prisma.constituencyResult.count({
    where: { electionId: election.id, electionType: "PARLIAMENTARY" },
  });
  console.log(`ConstituencyResult rows for this election + PARLIAMENTARY: ${count} (expect 275)`);

  const anyElection2020Results = await prisma.constituencyResult.findMany({
    where: { electionId: election.id },
    select: { electionType: true },
    distinct: ["electionType"],
  });
  console.log("Election types that DO have data for this election id:", anyElection2020Results.map(r => r.electionType));

  // Also check: is there possibly a SECOND "2020" election record?
  const all2020 = await prisma.election.findMany({ where: { code: "2020" } });
  console.log(`Total Election rows with code '2020': ${all2020.length}`, all2020.map(e => e.id));
}

main().catch(console.error).finally(() => prisma.$disconnect());
