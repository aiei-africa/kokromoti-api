import { PrismaClient, ResultSource } from "@prisma/client";
import * as fs from "fs";
import * as path from "path";

const prisma = new PrismaClient();

interface ResolvedCandidate { name: string; party: string; votes: number; elected: boolean; }
interface ResolvedConstituency {
  constituency: string; region: string;
  registered_voters: number | null;
  total_valid_votes: number; total_rejected_ballots: number; total_votes_cast: number;
  candidates: ResolvedCandidate[];
  notes?: string;
}

async function main() {
  console.log("── Kokromoti Seed 11: 2024 Parliamentary Results ──\n");

  const election = await prisma.election.findFirst({ where: { code: "2024" } });
  if (!election) throw new Error("2024 election not found");
  console.log(`Election: ${election.name} (${election.id})`);

  const country = await prisma.country.findFirst();
  if (!country) throw new Error("No Country record found");

  // PAG (Progressive Alliance for Ghana) — confirmed genuinely new for 2024
  // via real search (Nkrumaist party, first contested 2024).
  await prisma.party.upsert({
    where: { countryId_abbreviation: { countryId: country.id, abbreviation: "PAG" } },
    update: {},
    create: { name: "Progressive Alliance for Ghana", abbreviation: "PAG", countryId: country.id },
  });
  const allParties = await prisma.party.findMany();
  const partyByAbbrev = new Map(allParties.map((p) => [p.abbreviation, p.id]));
  console.log(`Parties confirmed: ${allParties.length} total (PAG added if not already present)\n`);

  const dataPath = path.join(__dirname, "../../db/seed-data/parliamentary_2024_resolved.json");
  const constituencies: ResolvedConstituency[] = JSON.parse(fs.readFileSync(dataPath, "utf-8"));
  console.log(`Loaded ${constituencies.length} resolved constituencies (expect 276)\n`);

  const dbConstituencies = await prisma.constituency.findMany({ select: { id: true, name: true } });
  const dbByUpperName = new Map(dbConstituencies.map((c) => [c.name.trim().toUpperCase(), c.id]));

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

  // ── Reuse registered_voters from the already-seeded 2024 PRESIDENTIAL
  // results — same election day, same voters register. Standing rule from
  // the 2020 seed, applied here in the same direction. ──
  const presResults = await prisma.constituencyResult.findMany({
    where: { electionId: election.id, electionType: "PRESIDENTIAL" },
    select: { constituencyId: true, registeredVoters: true },
  });
  const registeredVotersByConstituency = new Map(presResults.map((r) => [r.constituencyId, r.registeredVoters]));
  let reused = 0;
  for (const { constituencyId, data } of resolvedList) {
    const rv = registeredVotersByConstituency.get(constituencyId);
    if (rv != null) { data.registered_voters = rv; reused++; }
  }
  console.log(`Registered voters reused from 2024 presidential: ${reused}/${resolvedList.length}\n`);

  // ── Candidates — constituency-specific, batched (lesson from Seed 10's
  // hang: fetch existing first, dedupe in JS, createManyAndReturn only new
  // ones — never one sequential findFirst+create per candidate). ──
  const existingCandidates = await prisma.candidate.findMany({
    where: { electionId: election.id, electionType: "PARLIAMENTARY" },
  });
  const existingKey = (constituencyId: string, partyId: string | null, fullName: string) =>
    `${constituencyId}|${partyId ?? "IND"}|${fullName}`;
  const candidateIdByKey = new Map<string, string>();
  for (const c of existingCandidates) {
    candidateIdByKey.set(existingKey(c.constituencyId!, c.partyId, c.fullName), c.id);
  }

  const toCreate: { electionId: string; electionType: "PARLIAMENTARY"; constituencyId: string; partyId: string | null; fullName: string; isIncumbent: boolean }[] = [];
  const seenThisRun = new Set<string>();
  for (const { constituencyId, data } of resolvedList) {
    for (const cand of data.candidates) {
      const partyId = cand.party === "IND" ? null : partyByAbbrev.get(cand.party) ?? null;
      const k = existingKey(constituencyId, partyId, cand.name);
      if (candidateIdByKey.has(k) || seenThisRun.has(k)) continue;
      seenThisRun.add(k);
      toCreate.push({
        electionId: election.id, electionType: "PARLIAMENTARY", constituencyId, partyId, fullName: cand.name,
        isIncumbent: false,
      });
    }
  }
  for (let i = 0; i < toCreate.length; i += 500) {
    const created = await prisma.candidate.createManyAndReturn({ data: toCreate.slice(i, i + 500) });
    for (const c of created) candidateIdByKey.set(existingKey(c.constituencyId!, c.partyId, c.fullName), c.id);
  }
  console.log(`Candidates created/confirmed: ${candidateIdByKey.size}\n`);

  // ── ConstituencyResults — batched ──
  const resultCreateData = resolvedList.map(({ constituencyId, data }) => {
    const turnoutPct = data.registered_voters && data.total_votes_cast
      ? Number(((data.total_votes_cast / data.registered_voters) * 100).toFixed(3))
      : null;
    return {
      electionId: election.id, electionType: "PARLIAMENTARY" as const, constituencyId,
      registeredVoters: data.registered_voters, totalCast: data.total_votes_cast,
      validVotes: data.total_valid_votes, rejectedBallots: data.total_rejected_ballots,
      turnoutPct, source: "EC_OFFICIAL" as ResultSource, status: "DECLARED" as const,
      declaredAt: new Date("2024-12-08"), notes: data.notes ?? null,
    };
  });
  const createdResults = await prisma.constituencyResult.createManyAndReturn({ data: resultCreateData, skipDuplicates: true });
  console.log(`ConstituencyResults written: ${createdResults.length}`);

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
    const candidateSum = data.candidates.reduce((s, c) => s + c.votes, 0);
    if (candidateSum !== data.total_valid_votes && !data.notes) {
      console.log(`  ⚠ unexpected checksum mismatch: ${data.constituency} (sum=${candidateSum}, stated=${data.total_valid_votes})`);
      checksumFails++;
    }
    for (const cand of data.candidates) {
      const candidateId = candidateIdByKey.get(existingKey(constituencyId, cand.party === "IND" ? null : partyByAbbrev.get(cand.party) ?? null, cand.name))!;
      voteCreateData.push({
        constituencyResultId: resultId, candidateId, votes: cand.votes,
        voteShare: Number(((cand.votes / data.total_valid_votes) * 100).toFixed(4)),
      });
    }
  }
  console.log(`Unexpected checksum failures: ${checksumFails} (expect 0 — the 8 known ones already carry explanatory notes)`);

  for (let i = 0; i < voteCreateData.length; i += 500) {
    await prisma.constituencyResultVote.createMany({ data: voteCreateData.slice(i, i + 500), skipDuplicates: true });
  }
  console.log(`ConstituencyResultVotes written: ${voteCreateData.length}`);

  console.log("\n── Seed 11 complete ──");
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
