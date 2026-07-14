import { PrismaClient, ResultSource } from "@prisma/client";
import * as fs from "fs";
import * as path from "path";

const prisma = new PrismaClient();

interface ResolvedCandidate { name: string; party: string; votes: number; elected: boolean; }
interface ResolvedConstituency {
  constituency: string; region: string; total_valid_votes: number;
  candidates: ResolvedCandidate[];
}

async function main() {
  console.log("── Kokromoti Seed 13: 2016 Parliamentary Results (Gazette, replacing provisional data) ──\n");

  const election = await prisma.election.findFirst({ where: { code: "2016" } });
  if (!election) throw new Error("2016 election not found");

  // ── The existing 162 rows are provisional live-coverage data from
  // election night (Multimedia Group), not certified figures. This
  // gazette-derived, corrected dataset supersedes them entirely — clean
  // replace, not a supplement. ──
  const existing = await prisma.constituencyResult.findMany({
    where: { electionId: election.id, electionType: "PARLIAMENTARY" },
    select: { id: true },
  });
  console.log(`Existing provisional results to remove: ${existing.length}`);
  const existingIds = existing.map((r) => r.id);
  const deletedVotes = await prisma.constituencyResultVote.deleteMany({
    where: { constituencyResultId: { in: existingIds } },
  });
  const deletedResults = await prisma.constituencyResult.deleteMany({
    where: { id: { in: existingIds } },
  });
  console.log(`Deleted ${deletedVotes.count} vote rows, ${deletedResults.count} result rows\n`);

  const dataPath = path.join(__dirname, "../../db/seed-data/parl_2016_resolved.json");
  const constituencies: ResolvedConstituency[] = JSON.parse(fs.readFileSync(dataPath, "utf-8"));
  console.log(`Loaded ${constituencies.length} resolved constituencies (expect 275 — Guan didn't exist in 2016)\n`);

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

  // ── Candidates — constituency-specific, batched (same lesson as Seed 10). ──
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
  const resultCreateData = resolvedList.map(({ constituencyId, data }) => ({
    electionId: election.id, electionType: "PARLIAMENTARY" as const, constituencyId,
    registeredVoters: null, totalCast: null, rejectedBallots: null,
    validVotes: data.total_valid_votes, turnoutPct: null,
    source: "EC_OFFICIAL" as ResultSource, status: "DECLARED" as const,
    declaredAt: new Date("2016-12-21"),
    notes: data.constituency === "AKROFUOM"
      ? "Corrected against ec.gov.gh gazette: original PDF had a three-way circular vote-total swap among the three real candidates (Oppong/Appiah-Pinkrah/Zuma). Winner identity (Appiah-Pinkrah, NPP) confirmed via parliament.gh official MP roster before correcting."
      : data.constituency === "OKAIKWEI SOUTH"
      ? "Corrected against ghelection.com (independently matching the gazette's own vote totals exactly: 33,820/21,944/1,470/279 and identical percentages). The gazette PDF had swapped the top two candidate names with Okaikwei North's real candidates (Ahmed Arthur, Alexander Ackuaku — a genuine name coincidence between two adjacent constituencies' real candidates, not a fabricated identity). An earlier attempt to fix this using a Ghanaian Times article about Ernest Adomako was itself wrong — that article was about a later election (its '28 years' framing places it well after 2016), not this one. Resolved fully once verified against a source showing 1996-2020 continuous NPP history for this seat."
      : "Sourced from EC 'Detailed Parliamentary Election Results' gazette (dated 21 Dec 2016), replacing provisional live-coverage data. registered_voters/rejected_ballots/total_cast not carried through this specific conversion — total_valid_votes computed as the candidate-vote sum.",
  }));
  const createdResults = await prisma.constituencyResult.createManyAndReturn({ data: resultCreateData, skipDuplicates: true });
  console.log(`ConstituencyResults written: ${createdResults.length}`);

  const allResults = await prisma.constituencyResult.findMany({
    where: { electionId: election.id, electionType: "PARLIAMENTARY" },
    select: { id: true, constituencyId: true },
  });
  const resultIdByConstituency = new Map(allResults.map((r) => [r.constituencyId, r.id]));

  const voteCreateData: { constituencyResultId: string; candidateId: string; votes: number; voteShare: number }[] = [];
  for (const { constituencyId, data } of resolvedList) {
    const resultId = resultIdByConstituency.get(constituencyId);
    if (!resultId) continue;
    for (const cand of data.candidates) {
      const partyId = cand.party === "IND" ? null : partyByAbbrev.get(cand.party) ?? null;
      const candidateId = candidateIdByKey.get(existingKey(constituencyId, partyId, cand.name))!;
      voteCreateData.push({
        constituencyResultId: resultId, candidateId, votes: cand.votes,
        voteShare: Number(((cand.votes / data.total_valid_votes) * 100).toFixed(4)),
      });
    }
  }
  for (let i = 0; i < voteCreateData.length; i += 500) {
    await prisma.constituencyResultVote.createMany({ data: voteCreateData.slice(i, i + 500), skipDuplicates: true });
  }
  console.log(`ConstituencyResultVotes written: ${voteCreateData.length}`);

  console.log("\n── Seed 13 complete ──");
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
