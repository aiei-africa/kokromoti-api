import { PrismaClient, ResultSource } from "@prisma/client";
import * as fs from "fs";
import * as path from "path";

const prisma = new PrismaClient();

interface ResolvedCandidate {
  name: string; party: string; sex: string; age: number | null; votes: number; elected: boolean;
}
interface ResolvedConstituency {
  constituency: string; region: string;
  registered_voters: number | null;
  total_valid_votes: number | null;
  total_rejected_ballots: number | null;
  total_votes_cast: number | null;
  candidates: ResolvedCandidate[];
}

async function main() {
  console.log("── Kokromoti Seed 10: 2020 Parliamentary Results ──\n");

  const election = await prisma.election.findFirst({ where: { code: "2020" } });
  if (!election) throw new Error("2020 election record not found — expected it to already exist.");
  console.log(`Election: ${election.name} (${election.id})`);

  const dataPath = path.join(__dirname, "../../db/seed-data/parliamentary_2020_resolved.json");
  const constituencies: ResolvedConstituency[] = JSON.parse(fs.readFileSync(dataPath, "utf-8"));
  console.log(`Loaded ${constituencies.length} resolved constituencies (expect 275 — Guan didn't exist in 2020)\n`);

  // ── Resolve constituency names to real DB ids ──
  const dbConstituencies = await prisma.constituency.findMany({ select: { id: true, name: true } });
  const dbByUpperName = new Map(dbConstituencies.map((c) => [c.name.trim().toUpperCase(), c.id]));

  const allParties = await prisma.party.findMany();
  const partyByAbbrev = new Map(allParties.map((p) => [p.abbreviation, p.id]));

  let resolved = 0;
  const unresolved: string[] = [];
  const resolvedList: { constituencyId: string; data: ResolvedConstituency }[] = [];
  for (const c of constituencies) {
    const id = dbByUpperName.get(c.constituency.trim().toUpperCase());
    if (id) { resolvedList.push({ constituencyId: id, data: c }); resolved++; }
    else unresolved.push(c.constituency);
  }
  console.log(`Constituency resolution: ${resolved}/${constituencies.length}`);
  if (unresolved.length) console.log("  UNRESOLVED (needs investigation):", unresolved);

  // ── Candidates — parliamentary candidates are constituency-specific,
  // unlike presidential's national candidates. findFirst+create (not
  // upsert) to safely handle the independent seat's null partyId, same
  // Prisma compound-unique-key limitation hit in Seed 09. ──
  const candidateIdByKey = new Map<string, string>();
  for (const { constituencyId, data } of resolvedList) {
    for (const cand of data.candidates) {
      const partyId = cand.party === "IND" ? null : partyByAbbrev.get(cand.party) ?? null;
      const key = `${constituencyId}|${cand.name}`;
      let candidate = await prisma.candidate.findFirst({
        where: {
          electionId: election.id, electionType: "PARLIAMENTARY",
          constituencyId, partyId, fullName: cand.name,
        },
      });
      if (!candidate) {
        candidate = await prisma.candidate.create({
          data: {
            electionId: election.id, electionType: "PARLIAMENTARY",
            constituencyId, partyId, fullName: cand.name,
            gender: cand.sex === "M" ? "MALE" : cand.sex === "F" ? "FEMALE" : null,
            age: cand.age, isIncumbent: false,
          },
        });
      }
      candidateIdByKey.set(key, candidate.id);
    }
  }
  console.log(`Candidates created/confirmed: ${candidateIdByKey.size}\n`);

  // ── ConstituencyResults — batched (createManyAndReturn), not per-row ──
  const resultCreateData = resolvedList.map(({ constituencyId, data }) => {
    const turnoutPct = data.registered_voters && data.total_votes_cast
      ? Number(((data.total_votes_cast / data.registered_voters) * 100).toFixed(3))
      : null;
    return {
      electionId: election.id,
      electionType: "PARLIAMENTARY" as const,
      constituencyId,
      registeredVoters: data.registered_voters,
      totalCast: data.total_votes_cast,
      validVotes: data.total_valid_votes,
      rejectedBallots: data.total_rejected_ballots,
      turnoutPct,
      source: "EC_OFFICIAL" as ResultSource,
      status: "DECLARED" as const,
      declaredAt: new Date("2020-12-09"),
    };
  });

  const createdResults = await prisma.constituencyResult.createManyAndReturn({
    data: resultCreateData,
    skipDuplicates: true,
  });
  console.log(`ConstituencyResults written: ${createdResults.length}`);

  // if this is a re-run and some already existed, fetch the FULL set (not
  // just newly-created ones) so vote-creation covers every constituency —
  // exact bug class caught and fixed in Seed 09
  const allResults = await prisma.constituencyResult.findMany({
    where: { electionId: election.id, electionType: "PARLIAMENTARY" },
    select: { id: true, constituencyId: true },
  });
  const resultIdByConstituency = new Map(allResults.map((r) => [r.constituencyId, r.id]));

  let checksumFails = 0;
  const voteCreateData: { constituencyResultId: string; candidateId: string; votes: number; voteShare: number }[] = [];
  for (const { constituencyId, data } of resolvedList) {
    const resultId = resultIdByConstituency.get(constituencyId);
    if (!resultId) continue;
    const validVotes = data.total_valid_votes;
    const candidateSum = data.candidates.reduce((s, c) => s + c.votes, 0);
    if (validVotes !== null && candidateSum !== validVotes) {
      console.log(`  ⚠ checksum mismatch: ${data.constituency} (sum=${candidateSum}, stated=${validVotes})`);
      checksumFails++;
    }
    for (const cand of data.candidates) {
      const candidateId = candidateIdByKey.get(`${constituencyId}|${cand.name}`)!;
      voteCreateData.push({
        constituencyResultId: resultId,
        candidateId,
        votes: cand.votes,
        voteShare: validVotes ? Number(((cand.votes / validVotes) * 100).toFixed(4)) : 0,
      });
    }
  }
  console.log(`Unexpected checksum failures: ${checksumFails} (expect 0)`);

  for (let i = 0; i < voteCreateData.length; i += 500) {
    await prisma.constituencyResultVote.createMany({ data: voteCreateData.slice(i, i + 500), skipDuplicates: true });
  }
  console.log(`ConstituencyResultVotes written: ${voteCreateData.length}`);

  console.log("\n── Seed 10 complete ──");
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
