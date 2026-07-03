// ═══════════════════════════════════════════════════════════════════
// KOKROMOTI — Seed 02: Elections · Parties · Candidates
// 12 elections (runoffs as round-2 records) · 23 parties · 5,396 candidates
// (39 presidential + 5,357 parliamentary, 1992–2012 incl. runoffs).
// 2016 candidates deferred to the 2016/2020/2024 completion workstream
// (legacy list is a 2012 clone — see db/seed-data/corrections.md).
// Idempotent. Requires Seed 01. Run: npx tsx src/seed/02-elections-parties-candidates.ts
// © 2026 AIEI / Ayivi Solutions Limited
// ═══════════════════════════════════════════════════════════════════

import { PrismaClient, ElectionStatus, ElectionType, Gender } from "@prisma/client";
import * as fs from "fs";
import * as path from "path";

const prisma = new PrismaClient();
const DATA = path.join(__dirname, "..", "..", "db", "seed-data");
const load = <T,>(f: string): T => JSON.parse(fs.readFileSync(path.join(DATA, f), "utf-8")) as T;

interface ElectionSeed {
  legacyElectId: number; code: string; name: string; year: number; round: number;
  parentCode: string | null; parliamentLabel: string | null; electionDate: string;
  status: string; isHistorical: boolean;
}
interface PartySeed {
  legacyPartId: number; name: string; abbreviation: string;
  colourHex: string | null; colourLight: string | null; colourBg: string | null;
}
interface CandidateSeed {
  legacyCandId: number; electionCode: string; electionType: "PRESIDENTIAL" | "PARLIAMENTARY";
  legacyPartId: number | null; legacyConstId: number | null;
  fullName: string; gender: "MALE" | "FEMALE" | null; age: number | null;
}

async function main() {
  console.log("── Kokromoti Seed 02: Elections · Parties · Candidates ──");
  const ghana = await prisma.country.findUniqueOrThrow({ where: { code: "GH" } });

  // 1 ── Elections (round 1 first, then runoffs so parents exist)
  const elections = load<ElectionSeed[]>("elections.json").sort((a, b) => a.round - b.round);
  const electionByCode = new Map<string, string>();
  for (const e of elections) {
    const rec = await prisma.election.upsert({
      where: { countryId_code: { countryId: ghana.id, code: e.code } },
      update: {
        name: e.name, parliamentLabel: e.parliamentLabel,
        status: e.status as ElectionStatus, isHistorical: e.isHistorical,
        legacyElectId: e.legacyElectId,
      },
      create: {
        countryId: ghana.id, code: e.code, name: e.name, year: e.year, round: e.round,
        parentElectionId: e.parentCode ? electionByCode.get(e.parentCode) ?? null : null,
        parliamentLabel: e.parliamentLabel, electionDate: new Date(e.electionDate),
        status: e.status as ElectionStatus, isHistorical: e.isHistorical,
        legacyElectId: e.legacyElectId,
      },
    });
    electionByCode.set(e.code, rec.id);
  }
  console.log(`Elections: ${electionByCode.size}`);

  // 2 ── Parties
  const parties = load<PartySeed[]>("parties.json");
  const partyByLegacy = new Map<number, string>();
  for (const p of parties) {
    const rec = await prisma.party.upsert({
      where: { countryId_abbreviation: { countryId: ghana.id, abbreviation: p.abbreviation } },
      update: {
        name: p.name, colourHex: p.colourHex, colourLight: p.colourLight,
        colourBg: p.colourBg, legacyPartId: p.legacyPartId,
      },
      create: { countryId: ghana.id, ...p },
    });
    partyByLegacy.set(p.legacyPartId, rec.id);
  }
  console.log(`Parties: ${partyByLegacy.size}`);

  // 3 ── Candidates — idempotency via (electionType, legacyCandId)
  const consts = await prisma.constituency.findMany({
    where: { legacyConstId: { not: null } }, select: { id: true, legacyConstId: true },
  });
  const constByLegacy = new Map(consts.map((c) => [c.legacyConstId!, c.id]));

  const existing = await prisma.candidate.findMany({
    where: { legacyCandId: { not: null } }, select: { electionType: true, legacyCandId: true },
  });
  const have = new Set(existing.map((c) => `${c.electionType}:${c.legacyCandId}`));

  const cands = load<CandidateSeed[]>("candidates.json")
    .filter((c) => !have.has(`${c.electionType}:${c.legacyCandId}`));

  const CHUNK = 1000;
  let inserted = 0;
  for (let i = 0; i < cands.length; i += CHUNK) {
    const batch = cands.slice(i, i + CHUNK).map((c) => ({
      electionId: electionByCode.get(c.electionCode)!,
      electionType: c.electionType as ElectionType,
      partyId: c.legacyPartId ? partyByLegacy.get(c.legacyPartId) ?? null : null,
      constituencyId: c.legacyConstId ? constByLegacy.get(c.legacyConstId) ?? null : null,
      fullName: c.fullName,
      gender: c.gender ? (c.gender as Gender) : null,
      age: c.age,
      legacyCandId: c.legacyCandId,
    }));
    const res = await prisma.candidate.createMany({ data: batch, skipDuplicates: true });
    inserted += res.count;
    process.stdout.write(`\rCandidates: ${Math.min(i + CHUNK, cands.length)}/${cands.length} processed (${inserted} inserted)`);
  }
  console.log(cands.length ? "" : "Candidates: all already present");

  // 4 ── Reconciliation
  const counts = {
    elections: await prisma.election.count(),
    parties: await prisma.party.count(),
    prez: await prisma.candidate.count({ where: { electionType: "PRESIDENTIAL" } }),
    parl: await prisma.candidate.count({ where: { electionType: "PARLIAMENTARY" } }),
    indep: await prisma.candidate.count({ where: { partyId: null } }),
    female: await prisma.candidate.count({ where: { gender: "FEMALE" } }),
  };
  console.log("── Reconciliation ──");
  console.log(`  elections:            ${counts.elections}  (expect 12)`);
  console.log(`  parties:              ${counts.parties}  (expect 23)`);
  console.log(`  presidential cands:   ${counts.prez}  (expect 39)`);
  console.log(`  parliamentary cands:  ${counts.parl}  (expect 5357)`);
  console.log(`  independents:         ${counts.indep}`);
  console.log(`  female candidates:    ${counts.female}  (expect 505)`);
  console.log("── Seed 02 complete ──");
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
