import { PrismaClient, ResultSource } from "@prisma/client";
import * as fs from "fs";
import * as path from "path";

const prisma = new PrismaClient();

interface ResolvedCandidate { name: string; party: string; votes: number; }
interface ResolvedConstituency {
  constituency: string; region: string;
  registered_voters: number | null;
  total_valid_votes: number; total_rejected_ballots: number; total_votes_cast: number;
  candidates: ResolvedCandidate[];
  notes?: string;
}

async function main() {
  console.log("── Kokromoti Seed 12: 2020 Presidential Results ──\n");

  const election = await prisma.election.findFirst({ where: { code: "2020" } });
  if (!election) throw new Error("2020 election not found");
  console.log(`Election: ${election.name} (${election.id})`);

  const dataPath = path.join(__dirname, "../../db/seed-data/presidential_2020_resolved.json");
  const constituencies: ResolvedConstituency[] = JSON.parse(fs.readFileSync(dataPath, "utf-8"));
  console.log(`Loaded ${constituencies.length} resolved constituencies (expect 275 — Guan didn't exist in 2020)\n`);

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
  if (unresolved.length) console.log("  UNRESOLVED:", unresolved);

  // ── Registered voters — reused from the already-seeded 2020 PARLIAMENTARY
  // data (same election day, same register). Unlike 2024, this one
  // genuinely works: the 2020 parliamentary source had real per-constituency
  // figures throughout. ──
  const parlResults = await prisma.constituencyResult.findMany({
    where: { electionId: election.id, electionType: "PARLIAMENTARY" },
    select: { constituencyId: true, registeredVoters: true },
  });
  const registeredVotersByConstituency = new Map(parlResults.map((r) => [r.constituencyId, r.registeredVoters]));
  let reused = 0;
  for (const { constituencyId, data } of resolvedList) {
    const rv = registeredVotersByConstituency.get(constituencyId);
    if (rv != null) { data.registered_voters = rv; reused++; }
  }
  console.log(`Registered voters reused from 2020 parliamentary: ${reused}/${resolvedList.length} (expect 275)\n`);

  // ── Candidates — national (presidential), matching Seed 09's pattern:
  // findFirst+create (not upsert, since constituencyId=null trips Prisma's
  // null-in-compound-key limitation). Only 12 candidates total, so no
  // batching concern here the way parliamentary needed. ──
  const candidateIdByName = new Map<string, string>();
  const candidateNames = new Set<string>();
  for (const c of resolvedList) for (const cand of c.data.candidates) candidateNames.add(`${cand.name}|${cand.party}`);

  for (const entry of candidateNames) {
    const [name, party] = entry.split("|");
    const partyId = party === "IND" ? null : partyByAbbrev.get(party) ?? null;
    let candidate = await prisma.candidate.findFirst({
      where: { electionId: election.id, electionType: "PRESIDENTIAL", constituencyId: null, partyId, fullName: name },
    });
    if (!candidate) {
      candidate = await prisma.candidate.create({
        data: { electionId: election.id, electionType: "PRESIDENTIAL", constituencyId: null, partyId, fullName: name },
      });
    }
    candidateIdByName.set(name, candidate.id);
  }
  console.log(`Candidates created/confirmed: ${candidateIdByName.size} (expect 12)\n`);

  // ── ConstituencyResults — batched ──
  const resultCreateData = resolvedList.map(({ constituencyId, data }) => {
    const turnoutPct = data.registered_voters && data.total_votes_cast
      ? Number(((data.total_votes_cast / data.registered_voters) * 100).toFixed(3))
      : null;
    return {
      electionId: election.id, electionType: "PRESIDENTIAL" as const, constituencyId,
      registeredVoters: data.registered_voters, totalCast: data.total_votes_cast,
      validVotes: data.total_valid_votes, rejectedBallots: data.total_rejected_ballots,
      turnoutPct, source: "EC_OFFICIAL" as ResultSource, status: "DECLARED" as const,
      declaredAt: new Date("2020-12-09"), notes: data.notes ?? null,
    };
  });
  const createdResults = await prisma.constituencyResult.createManyAndReturn({ data: resultCreateData, skipDuplicates: true });
  console.log(`ConstituencyResults written: ${createdResults.length}`);

  const allResults = await prisma.constituencyResult.findMany({
    where: { electionId: election.id, electionType: "PRESIDENTIAL" },
    select: { id: true, constituencyId: true },
  });
  const resultIdByConstituency = new Map(allResults.map((r) => [r.constituencyId, r.id]));

  let checksumFails = 0;
  const voteCreateData: { constituencyResultId: string; candidateId: string; votes: number; voteShare: number }[] = [];
  for (const { constituencyId, data } of resolvedList) {
    const resultId = resultIdByConstituency.get(constituencyId);
    if (!resultId) continue;
    const candidateSum = data.candidates.reduce((s, c) => s + c.votes, 0);
    if (candidateSum !== data.total_valid_votes && !data.notes) {
      console.log(`  ⚠ unexpected checksum mismatch: ${data.constituency} (sum=${candidateSum}, stated=${data.total_valid_votes})`);
      checksumFails++;
    }
    for (const cand of data.candidates) {
      const candidateId = candidateIdByName.get(cand.name)!;
      voteCreateData.push({
        constituencyResultId: resultId, candidateId, votes: cand.votes,
        voteShare: Number(((cand.votes / data.total_valid_votes) * 100).toFixed(4)),
      });
    }
  }
  console.log(`Unexpected checksum failures: ${checksumFails} (expect 0 — the 11 known ones already carry explanatory notes)`);

  for (let i = 0; i < voteCreateData.length; i += 500) {
    await prisma.constituencyResultVote.createMany({ data: voteCreateData.slice(i, i + 500), skipDuplicates: true });
  }
  console.log(`ConstituencyResultVotes written: ${voteCreateData.length}`);

  console.log("\n── Seed 12 complete ──");
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
