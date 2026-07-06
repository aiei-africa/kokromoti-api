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
  // upsert can't be used (same null-in-compound-key Prisma limitation as
  // Seed 09), but the ORIGINAL fix here still did one sequential
  // findFirst+create PER CANDIDATE PER CONSTITUENCY — ~800-1000 round-trips
  // for parliamentary (unlike presidential's 13 national candidates), the
  // exact per-row-sequential anti-pattern that caused Seed 09's hang,
  // reintroduced here. Properly batched now: fetch all existing candidates
  // for this election+type in ONE query, dedupe the DB's own unique
  // constraint quirk (NULL != NULL in Postgres, so skipDuplicates can't be
  // trusted for the independent candidate's null partyId) ourselves in JS,
  // then createManyAndReturn only the genuinely new ones in one batch.
  const existingCandidates = await prisma.candidate.findMany({
    where: { electionId: election.id, electionType: "PARLIAMENTARY" },
  });
  const existingKey = (constituencyId: string, partyId: string | null, fullName: string) =>
    `${constituencyId}|${partyId ?? "IND"}|${fullName}`;
  const candidateIdByKey = new Map<string, string>();
  for (const c of existingCandidates) {
    candidateIdByKey.set(existingKey(c.constituencyId!, c.partyId, c.fullName), c.id);
  }

  const toCreate: { electionId: string; electionType: "PARLIAMENTARY"; constituencyId: string; partyId: string | null; fullName: string; gender: "MALE" | "FEMALE" | null; age: number | null; isIncumbent: boolean }[] = [];
  const seenThisRun = new Set<string>();
  for (const { constituencyId, data } of resolvedList) {
    for (const cand of data.candidates) {
      const partyId = cand.party === "IND" ? null : partyByAbbrev.get(cand.party) ?? null;
      const k = existingKey(constituencyId, partyId, cand.name);
      if (candidateIdByKey.has(k) || seenThisRun.has(k)) continue;
      seenThisRun.add(k);
      toCreate.push({
        electionId: election.id, electionType: "PARLIAMENTARY", constituencyId, partyId, fullName: cand.name,
        gender: cand.sex === "M" ? "MALE" : cand.sex === "F" ? "FEMALE" : null,
        age: cand.age, isIncumbent: false,
      });
    }
  }

  for (let i = 0; i < toCreate.length; i += 500) {
    const chunk = toCreate.slice(i, i + 500);
    const created = await prisma.candidate.createManyAndReturn({ data: chunk });
    for (const c of created) candidateIdByKey.set(existingKey(c.constituencyId!, c.partyId, c.fullName), c.id);
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
      const partyId = cand.party === "IND" ? null : partyByAbbrev.get(cand.party) ?? null;
      const candidateId = candidateIdByKey.get(existingKey(constituencyId, partyId, cand.name))!;
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
