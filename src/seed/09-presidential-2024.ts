import { PrismaClient, ResultSource, CollationStatus } from "@prisma/client";
import * as fs from "fs";
import * as path from "path";
import {
  CONSTITUENCY_ALIASES_2024,
  MISSING_CONSTITUENCY_2024,
} from "./constituency-aliases-2024";

const prisma = new PrismaClient();

interface ResolvedCandidate { name: string; party: string; votes: number; }
interface ResolvedConstituency {
  constituency: string;
  region: string;
  registered_voters: number | null;
  total_valid_votes: number | null;
  total_rejected_ballots: number | null;
  total_votes_cast: number | null;
  candidates: ResolvedCandidate[];
  source: "EC_OFFICIAL" | "MANUAL";
  notes?: string;
}

async function main() {
  console.log("── Kokromoti Seed 09: 2024 Presidential Results ──\n");

  const election = await prisma.election.findFirst({ where: { code: "2024" } });
  if (!election) throw new Error("2024 election record not found — expected it to already exist from the original elections seed.");
  console.log(`Election: ${election.name} (${election.id})`);

  const country = await prisma.country.findFirst();
  if (!country) throw new Error("No Country record found — expected Ghana to already exist.");

  // ── Step 1: parties — LPG and GUM are genuinely new for 2024, confirmed
  // absent from the 25-party 1992-2016 set. Party's unique key is compound
  // (countryId_abbreviation), not abbreviation alone. ──
  const newParties = [
    { name: "Liberal Party of Ghana", abbreviation: "LPG" },
    { name: "Ghana Union Movement", abbreviation: "GUM" },
  ];
  for (const p of newParties) {
    await prisma.party.upsert({
      where: { countryId_abbreviation: { countryId: country.id, abbreviation: p.abbreviation } },
      update: {},
      create: { ...p, countryId: country.id },
    });
  }
  const allParties = await prisma.party.findMany();
  const partyByAbbrev = new Map(allParties.map((p) => [p.abbreviation, p.id]));
  console.log(`Parties confirmed: ${allParties.length} total (LPG, GUM added if not already present)\n`);

  // ── Step 2: load resolved source data ──
  const dataPath = path.join(__dirname, "../../db/seed-data/presidential_2024_resolved.json");
  const constituencies: ResolvedConstituency[] = JSON.parse(fs.readFileSync(dataPath, "utf-8"));
  console.log(`Loaded ${constituencies.length} resolved constituencies from source data`);

  // ── Step 3: create the 13 presidential candidates for 2024 ──
  // constituencyId is null for presidential candidates by schema convention
  // (they run nationally; per-constituency vote counts live on
  // ConstituencyResultVote instead, keyed by candidateId).
  const candidateNames = new Set<string>();
  for (const c of constituencies) {
    for (const cand of c.candidates) candidateNames.add(`${cand.name}|${cand.party}`);
  }

  const candidateByName = new Map<string, string>();
  for (const entry of candidateNames) {
    const [name, party] = entry.split("|");
    const partyId = party === "IND" ? null : partyByAbbrev.get(party) ?? null;
    // upsert can't be used here: Prisma's compound-unique `where` type
    // rejects a literal null for constituencyId even though the column
    // itself is nullable (NULL isn't self-equal in SQL uniqueness terms).
    // findFirst uses a plain filter instead, which does accept null —
    // preserves the same idempotent re-run safety upsert would have given.
    let candidate = await prisma.candidate.findFirst({
      where: {
        electionId: election.id,
        electionType: "PRESIDENTIAL",
        constituencyId: null,
        partyId,
        fullName: name,
      },
    });
    if (!candidate) {
      candidate = await prisma.candidate.create({
        data: {
          electionId: election.id,
          electionType: "PRESIDENTIAL",
          constituencyId: null,
          partyId,
          fullName: name,
        },
      });
    }
    candidateByName.set(name, candidate.id);
  }
  console.log(`Candidates created/confirmed: ${candidateByName.size} (expect 13)\n`);

  // ── Step 4: resolve every constituency name to its real DB id ──
  const dbConstituencies = await prisma.constituency.findMany({ select: { id: true, name: true } });
  const dbByUpperName = new Map(dbConstituencies.map((c) => [c.name.trim().toUpperCase(), c.id]));

  let resolved = 0, unresolved: string[] = [];
  const resultsToCreate: { constituencyId: string; data: ResolvedConstituency }[] = [];

  for (const c of constituencies) {
    const raw = c.constituency.trim().toUpperCase();
    const canonical = (CONSTITUENCY_ALIASES_2024[raw] ?? raw).trim().toUpperCase();
    const id = dbByUpperName.get(canonical);
    if (id) {
      resultsToCreate.push({ constituencyId: id, data: c });
      resolved++;
    } else {
      unresolved.push(c.constituency);
    }
  }
  console.log(`Constituency resolution: ${resolved}/${constituencies.length} resolved`);
  if (unresolved.length) {
    console.log("  UNRESOLVED (needs investigation, not expected):", unresolved);
  }

  // ── Step 5: write ConstituencyResult + ConstituencyResultVote, properly
  // batched. The original version did 275 × 3 sequential awaited queries
  // (825 round-trips) — exactly the per-row-sequential anti-pattern this
  // project already learned kills the pooled cross-continent connection.
  // Rebuilt to: one groupBy for station counts, one createManyAndReturn for
  // results (Prisma 6.19.3 + Postgres supports this), one batched createMany
  // for all vote rows. ──

  const stationCounts = await prisma.pollingStation.groupBy({
    by: ["constituencyId"],
    _count: { id: true },
  });
  const stationCountByConstituency = new Map(stationCounts.map((s) => [s.constituencyId, s._count.id]));

  const resultCreateData = resultsToCreate.map(({ constituencyId, data }) => {
    const stationsTotal = stationCountByConstituency.get(constituencyId) ?? 0;
    const turnoutPct = data.registered_voters && data.total_votes_cast
      ? Number(((data.total_votes_cast / data.registered_voters) * 100).toFixed(3))
      : null;
    return {
      electionId: election.id,
      electionType: "PRESIDENTIAL" as const,
      constituencyId,
      registeredVoters: data.registered_voters,
      totalCast: data.total_votes_cast,
      validVotes: data.total_valid_votes,
      rejectedBallots: data.total_rejected_ballots,
      turnoutPct,
      source: data.source as ResultSource,
      status: "DECLARED" as CollationStatus,
      stationsReporting: stationsTotal,
      stationsTotal,
      declaredAt: new Date("2024-12-08"),
      notes: data.notes ?? null,
    };
  });

  const createdResults = await prisma.constituencyResult.createManyAndReturn({
    data: resultCreateData,
    skipDuplicates: true,
  });
  console.log(`\nConstituencyResults written: ${createdResults.length}`);

  const resultIdByConstituency = new Map(createdResults.map((r) => [r.constituencyId, r.id]));

  // checksum guard — same logic as before, just run over the in-memory data
  // instead of inside the write loop
  let checksumFails = 0;
  const voteCreateData: { constituencyResultId: string; candidateId: string; votes: number; voteShare: number }[] = [];
  for (const { constituencyId, data } of resultsToCreate) {
    const resultId = resultIdByConstituency.get(constituencyId);
    if (!resultId) continue; // shouldn't happen, but skip rather than crash if it does
    const validVotes = data.total_valid_votes;
    const candidateSum = data.candidates.reduce((s, c) => s + c.votes, 0);
    if (validVotes !== null && candidateSum !== validVotes && !data.notes) {
      console.log(`  ⚠ unexpected checksum mismatch: ${data.constituency} (sum=${candidateSum}, stated=${validVotes})`);
      checksumFails++;
    }
    for (const cand of data.candidates) {
      voteCreateData.push({
        constituencyResultId: resultId,
        candidateId: candidateByName.get(cand.name)!,
        votes: cand.votes,
        voteShare: validVotes ? Number(((cand.votes / validVotes) * 100).toFixed(4)) : 0,
      });
    }
  }
  console.log(`Unexpected checksum failures: ${checksumFails} (expect 0 — the 3 known ones already carry explanatory notes)`);

  // batched in chunks of 500 — safe, established pattern from earlier seeds
  for (let i = 0; i < voteCreateData.length; i += 500) {
    const chunk = voteCreateData.slice(i, i + 500);
    await prisma.constituencyResultVote.createMany({ data: chunk, skipDuplicates: true });
  }
  console.log(`ConstituencyResultVotes written: ${voteCreateData.length}`);

  // ── Step 6: Ablekuma North — explicit DISPUTED record, no vote data ──
  const ablekumaId = dbByUpperName.get(MISSING_CONSTITUENCY_2024.toUpperCase());
  if (ablekumaId) {
    await prisma.constituencyResult.upsert({
      where: {
        electionId_electionType_constituencyId: {
          electionId: election.id, electionType: "PRESIDENTIAL", constituencyId: ablekumaId,
        },
      },
      update: {},
      create: {
        electionId: election.id,
        electionType: "PRESIDENTIAL",
        constituencyId: ablekumaId,
        registeredVoters: null,
        totalCast: null,
        validVotes: null,
        rejectedBallots: null,
        turnoutPct: null,
        source: "MANUAL",
        status: "DISPUTED",
        stationsReporting: 0,
        stationsTotal: await prisma.pollingStation.count({ where: { constituencyId: ablekumaId } }),
        declaredAt: null,
        notes: "Collation disrupted by electoral violence on election day (18 pink sheets disputed as missing during presidential collation; EC officials relocated to the regional collation office). The parliamentary seat for this constituency remained undeclared for months afterward, eventually requiring a partial rerun. Presidential vote data for this constituency could not be independently confirmed from any available source as of this seed and is recorded as genuinely unavailable, not zero.",
      },
    });
    console.log("\nAblekuma North: explicit DISPUTED record created — no vote data (genuine gap, not fabricated).");
  } else {
    console.log("\n⚠ Ablekuma North not found in constituency table — check spelling/seed order.");
  }

  console.log("\n── Seed 09 complete ──");
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
