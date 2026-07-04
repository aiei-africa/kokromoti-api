// ═══════════════════════════════════════════════════════════════════
// KOKROMOTI — Seed 07: Presidential Results — Full Replace (1992-2016)
//
// Supersedes everything currently seeded for PRESIDENTIAL constituency_results.
// Source: tblElectionResultsPrez.xls, the complete/authoritative export —
// full coverage confirmed across all 9 election records (274-276 of 276
// constituencies per year; only 1992 carries zero candidate-level votes,
// consistent with its already-documented non-gazetted/provisional status —
// registered-voter figures only, exactly as before).
// National roll-up pre-validated against known historical outcomes
// (2016: Akufo-Addo 53.72%, matching the real ~53.85% result) before
// this script was built.
// Batched throughout — delete old, insert new, in chunks, no per-row awaits.
// Requires Seeds 01-06b. Run: npx tsx src/seed/07-presidential-results-full.ts
// © 2026 AIEI / Ayivi Solutions Limited
// ═══════════════════════════════════════════════════════════════════

import { PrismaClient, ElectionType, ResultSource, CollationStatus } from "@prisma/client";
import * as fs from "fs";
import * as path from "path";

const prisma = new PrismaClient();
const DATA = path.join(__dirname, "..", "..", "db", "seed-data");

interface ResultRecord {
  electionCode: string; legacyConstId: number;
  registeredVoters: number | null; totalCast: number | null;
  validVotes: number | null; rejectedBallots: number | null;
  votes: { fullName: string; votes: number }[];
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function main() {
  console.log("── Kokromoti Seed 07: Presidential Results — Full Replace ──");
  const start = Date.now();

  const records: ResultRecord[] = JSON.parse(
    fs.readFileSync(path.join(DATA, "presidential_results_full.json"), "utf-8")
  );
  console.log(`Loaded ${records.length} presidential constituency-election records.`);

  // ── Step 1: delete existing presidential votes, then results
  const existingResults = await prisma.constituencyResult.findMany({
    where: { electionType: "PRESIDENTIAL" }, select: { id: true },
  });
  const existingIds = existingResults.map((r) => r.id);
  console.log(`\nDeleting ${existingIds.length} existing presidential results (and their votes)...`);

  for (const idBatch of chunk(existingIds, 1000)) {
    await prisma.constituencyResultVote.deleteMany({ where: { constituencyResultId: { in: idBatch } } });
  }
  for (const idBatch of chunk(existingIds, 1000)) {
    await prisma.constituencyResult.deleteMany({ where: { id: { in: idBatch } } });
  }
  console.log("  Old presidential results cleared.");

  // ── Step 2: lookups
  const elections = await prisma.election.findMany({ select: { id: true, code: true } });
  const electionByCode = new Map(elections.map((e) => [e.code, e.id]));
  const constituencies = await prisma.constituency.findMany({ where: { legacyConstId: { not: null } }, select: { id: true, legacyConstId: true } });
  const constByLegacy = new Map(constituencies.map((c) => [c.legacyConstId!, c.id]));
  const candidates = await prisma.candidate.findMany({ where: { electionType: "PRESIDENTIAL" }, select: { id: true, electionId: true, fullName: true } });
  const candByElectionName = new Map(candidates.map((c) => [`${c.electionId}:::${c.fullName}`, c.id]));

  // ── Step 3: build + batch-insert constituency_results
  console.log("\nInserting new presidential results...");
  const resultRows: any[] = [];
  let skippedNoElection = 0, skippedNoConst = 0;
  for (const rec of records) {
    const electionId = electionByCode.get(rec.electionCode);
    if (!electionId) { skippedNoElection++; continue; }
    const constituencyId = constByLegacy.get(rec.legacyConstId);
    if (!constituencyId) { skippedNoConst++; continue; }
    const turnoutPct = rec.registeredVoters && rec.totalCast
      ? Number(((rec.totalCast / rec.registeredVoters) * 100).toFixed(3)) : null;
    resultRows.push({
      electionId, electionType: ElectionType.PRESIDENTIAL, constituencyId,
      registeredVoters: rec.registeredVoters, totalCast: rec.totalCast,
      validVotes: rec.validVotes, rejectedBallots: rec.rejectedBallots, turnoutPct,
      source: ResultSource.HISTORICAL_IMPORT, status: CollationStatus.DECLARED, stationsReporting: 0,
      _electionCode: rec.electionCode, _legacyConstId: rec.legacyConstId,
    });
  }

  let inserted = 0;
  for (const batch of chunk(resultRows, 1000)) {
    const res = await prisma.constituencyResult.createMany({
      data: batch.map(({ _electionCode, _legacyConstId, ...r }) => r), skipDuplicates: true,
    });
    inserted += res.count;
  }
  console.log(`  Results inserted: ${inserted}`);

  // ── Step 4: re-fetch generated IDs, attach votes
  const freshResults = await prisma.constituencyResult.findMany({
    where: { electionType: "PRESIDENTIAL" }, select: { id: true, electionId: true, constituencyId: true },
  });
  const resultIdByKey = new Map(freshResults.map((r) => [`${r.electionId}:::${r.constituencyId}`, r.id]));

  const voteRows: any[] = [];
  let votesSkippedNoCand = 0;
  for (const rec of records) {
    const electionId = electionByCode.get(rec.electionCode);
    const constituencyId = electionId ? constByLegacy.get(rec.legacyConstId) : undefined;
    if (!electionId || !constituencyId) continue;
    const resultId = resultIdByKey.get(`${electionId}:::${constituencyId}`);
    if (!resultId) continue;
    for (const v of rec.votes) {
      const candidateId = candByElectionName.get(`${electionId}:::${v.fullName}`);
      if (!candidateId) { votesSkippedNoCand++; continue; }
      const voteShare = rec.validVotes ? Number(((v.votes / rec.validVotes) * 100).toFixed(4)) : null;
      voteRows.push({ constituencyResultId: resultId, candidateId, votes: v.votes, voteShare });
    }
  }

  let votesInserted = 0;
  for (const batch of chunk(voteRows, 2000)) {
    const res = await prisma.constituencyResultVote.createMany({ data: batch, skipDuplicates: true });
    votesInserted += res.count;
  }
  console.log(`  Vote lines inserted: ${votesInserted} (skipped, no candidate match: ${votesSkippedNoCand})`);
  if (skippedNoElection) console.warn(`  WARN: ${skippedNoElection} records skipped — election not found`);
  if (skippedNoConst) console.warn(`  WARN: ${skippedNoConst} records skipped — constituency not found`);

  // ── National roll-up sanity check
  console.log("\n── National Roll-Up Sanity Check ──");
  const allElections = await prisma.election.findMany({ where: { code: { not: "2028" } }, orderBy: { year: "asc" } });
  for (const e of allElections) {
    const votes = await prisma.constituencyResultVote.groupBy({
      by: ["candidateId"], where: { constituencyResult: { electionId: e.id, electionType: "PRESIDENTIAL" } }, _sum: { votes: true },
    });
    if (votes.length === 0) continue;
    const top = votes.sort((a, b) => (b._sum.votes ?? 0) - (a._sum.votes ?? 0))[0];
    const cand = await prisma.candidate.findUnique({ where: { id: top.candidateId }, select: { fullName: true } });
    const total = votes.reduce((s, v) => s + (v._sum.votes ?? 0), 0);
    const pct = total ? (((top._sum.votes ?? 0) / total) * 100).toFixed(2) : "0";
    console.log(`  ${e.code}: leader ${cand?.fullName} — ${top._sum.votes?.toLocaleString()} votes (${pct}%) of ${total.toLocaleString()} total`);
  }

  console.log("\n── Reconciliation ──");
  console.log(`  presidential constituency-results: ${inserted} (expect ~2039)`);
  console.log(`  vote lines: ${votesInserted}`);
  console.log(`  elapsed: ${((Date.now() - start) / 1000).toFixed(1)}s`);
  console.log("── Seed 07 complete ──");
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
