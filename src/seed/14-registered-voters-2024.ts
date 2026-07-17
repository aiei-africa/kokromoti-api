import { PrismaClient, ElectionType, Prisma } from "@prisma/client";
import * as fs from "fs";
import * as path from "path";

const prisma = new PrismaClient();

// ── Kokromoti Seed 14: 2024 Registered Voters (Presidential + Parliamentary) ──
//
// Source: registered_voters_2024_presidential.csv — EC 2024 voter register,
// per-constituency. The SAME register served both the presidential and
// parliamentary races, so this seed updates BOTH.
//
// RESOLUTION STRATEGY (v4 — supersedes v1/v2/v3 entirely):
//   v1 joined on legacyConstId and aborted with 16 unresolved rows — the
//   CSV's constituency_id uses a DIFFERENT legacy numbering in which the
//   2012-created constituencies + Guan carry high appended IDs (290–630),
//   while the DB's legacyConstId follows the ArcGIS map numbering. Since
//   the two systems demonstrably diverge, id-matching can't be trusted as
//   a join key AT ALL (a collision could silently join the wrong
//   constituency). v2 therefore resolves by NORMALIZED NAME as the primary
//   key — both sides carry 276 unique names — with legacyConstId demoted
//   to an informational cross-check report. Aborts (writing nothing) on
//   any name miss or any double-assignment.
//
// Scope (explicitly agreed):
//   • ONLY registered_voters is taken from this CSV. Its vote columns
//     (valid/rejected/cast/turnout) are IGNORED — 185/276 rows have
//     rejected=0 (missing, not real: national sum 87,465 vs EC's ~240k),
//     and the DB's pink-sheet-derived vote data is the superior source.
//   • turnout_pct is recomputed as DB.totalCast / CSV.registered wherever
//     the DB row already has totalCast; left untouched otherwise.
//   • Ablekuma North: the EC never declared its 2024 PRESIDENTIAL result,
//     but a correct placeholder row ALREADY EXISTS (created 6 Jul 2026:
//     status DISPUTED, source MANUAL, all vote fields null, detailed notes
//     on the collation disruption, stationsTotal 280, zero vote rows).
//     v3 wrongly assumed no row existed and tried to create one; v4 simply
//     updates it through the standard path — registeredVoters set to
//     121,266, turnoutPct untouched (totalCast is null), and its existing
//     notes/status/source deliberately preserved. Its PARLIAMENTARY result
//     WAS declared later (sitting MP; 276 MPs in the House) and gets a
//     normal registered-voters update.
//
// Phase 2 (OPT-IN, run with --with-aggregates): sums the same register into
// the 2024 RegionalResult (16 regions × 2 races) and NationalResult (2 races)
// rows' registeredVoters, recomputing their turnoutPct the same way. Regions
// are resolved via each constituency's own regionId in the DB — the CSV's
// hyphenated region slugs are never used.
//
// Connection discipline: all reference data fetched once into Maps; all
// writes run as chunked $transaction batches (single connection each) —
// never per-row awaited queries in a loop. Pool is capped at 5.

const WITH_AGGREGATES = process.argv.includes("--with-aggregates");
const CHUNK = 50;

// Manual aliases for CSV-name → DB-name spelling divergences that pure
// normalization can't bridge. Keys/values are NORMALIZED forms (see norm()).
// Every entry below was verified against a full dump of the DB's own
// constituency list (276 names) — the complete mapping was simulated
// offline to 276/276 with zero double-claims before this version shipped.
const NAME_ALIASES: Record<string, string> = {
  ELLEMBELE: "ELLEMBELLE", // CSV "Ellembele" → DB "Ellembelle"
  HEMANGLOWERDENKYIRA: "HERMANGLOWERDENKYIRA", // CSV "Hemang Lower Denkyira" → DB "Hermang Lower Denkyira"
  KOMENDAEDINAEGUAFOABREM: "KEEA", // CSV "Komenda Edina Eguafo Abrem" → DB "KEEA"
  TWIFOATTIMORKWA: "TWIFOATIIMORKWAA", // CSV "Twifo Atti Morkwa" → DB "Twifo-Atii Morkwaa"
  ADENTAN: "ADENTA", // CSV "Adentan" → DB "Adenta"
  ODODODIODIO: "ODODODIODIOO", // CSV "Odododiodio" → DB "Odododiodioo"
  AKROPONGAKUAPEMNORTH: "AKWAPEMNORTH", // CSV "Akropong / Akuapem North" → DB "Akwapem North"
  AKUAPIMSOUTH: "AKWAPEMSOUTH", // CSV "Akuapim South" → DB "Akwapem South"
  AKROFRUOM: "AKROFUOM", // CSV "Akrofruom" → DB "Akrofuom"
  EFIDUASEASOKORE: "EFFIDUASEASOKORE", // CSV "Efiduase/Asokore" → DB "Effiduase-Asokore"
  NEWEDUBEASE: "NEWEDUBIASE", // CSV "New Edubease" → DB "New Edubiase"
  ODOTOBRI: "ODOTOBIRI", // CSV "Odotobri" → DB "Odotobiri"
  GUSHEGU: "GUSHIEGU", // CSV "Gushegu" → DB "Gushiegu"
  LAMBUSSIE: "LAMBUSSIEKARNI", // CSV "Lambussie" → DB "Lambussie-Karni"
};

function norm(s: string): string {
  return s.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

interface CsvRow {
  csvId: number;
  constituencyName: string;
  registeredVoters: number;
}

function loadCsv(): CsvRow[] {
  const p = path.join(__dirname, "../../db/seed-data/registered_voters_2024_presidential.csv");
  const lines = fs.readFileSync(p, "utf-8").split(/\r?\n/).filter((l) => l.trim().length > 0);
  const header = lines[0].split(",");
  const idx = (name: string) => {
    const i = header.indexOf(name);
    if (i === -1) throw new Error(`CSV missing expected column: ${name}`);
    return i;
  };
  const iId = idx("constituency_id");
  const iName = idx("constituency_name");
  const iReg = idx("total_registered_voters");
  const rows: CsvRow[] = [];
  for (const line of lines.slice(1)) {
    const f = line.split(",");
    if (f.length !== header.length) throw new Error(`Malformed CSV line (${f.length} fields): ${line}`);
    const csvId = Number(f[iId]);
    const registeredVoters = Number(f[iReg]);
    if (!Number.isInteger(csvId) || !Number.isInteger(registeredVoters) || registeredVoters <= 0) {
      throw new Error(`Bad id/register value on line: ${line}`);
    }
    rows.push({ csvId, constituencyName: f[iName].trim(), registeredVoters });
  }
  return rows;
}

function turnout(totalCast: number | null, registered: number): Prisma.Decimal | undefined {
  if (totalCast === null || totalCast === undefined) return undefined; // leave untouched
  return new Prisma.Decimal(((totalCast / registered) * 100).toFixed(3));
}

async function runChunkedTransactions(ops: Prisma.PrismaPromise<unknown>[], label: string) {
  for (let i = 0; i < ops.length; i += CHUNK) {
    await prisma.$transaction(ops.slice(i, i + CHUNK));
  }
  console.log(`  ${label}: ${ops.length} writes committed (${Math.ceil(ops.length / CHUNK)} transaction batches)`);
}

async function main() {
  console.log("── Kokromoti Seed 14 (v4): 2024 Registered Voters (Presidential + Parliamentary) ──\n");
  console.log(`Aggregate phase (Regional/National): ${WITH_AGGREGATES ? "ENABLED (--with-aggregates)" : "SKIPPED (run with --with-aggregates to include)"}\n`);

  const csvRows = loadCsv();
  console.log(`CSV loaded: ${csvRows.length} constituencies (expect 276)`);
  if (csvRows.length !== 276) throw new Error(`Expected 276 CSV rows, got ${csvRows.length} — aborting.`);
  const csvTotal = csvRows.reduce((s, r) => s + r.registeredVoters, 0);
  console.log(`CSV national register total: ${csvTotal.toLocaleString()} (expect 18,760,371)\n`);

  const election = await prisma.election.findFirst({ where: { code: "2024" } });
  if (!election) throw new Error("2024 election not found");

  // ── Reference data: fetched ONCE ──
  const constituencies = await prisma.constituency.findMany({
    select: { id: true, name: true, legacyConstId: true, regionId: true },
  });
  console.log(`DB constituencies: ${constituencies.length}`);

  const constByNormName = new Map<string, (typeof constituencies)[number]>();
  for (const c of constituencies) {
    const key = norm(c.name);
    if (constByNormName.has(key)) throw new Error(`DB has two constituencies normalizing to "${key}" — cannot resolve by name. Aborting.`);
    constByNormName.set(key, c);
  }

  // ── Resolve every CSV row by normalized name — abort on any miss or double-claim ──
  const resolved: { csv: CsvRow; db: (typeof constituencies)[number] }[] = [];
  const misses: CsvRow[] = [];
  const claimed = new Map<string, string>(); // db constituency id -> csv name that claimed it
  for (const r of csvRows) {
    let key = norm(r.constituencyName);
    if (NAME_ALIASES[key]) key = NAME_ALIASES[key];
    const db = constByNormName.get(key);
    if (!db) { misses.push(r); continue; }
    const prior = claimed.get(db.id);
    if (prior) throw new Error(`Double-assignment: CSV rows "${prior}" and "${r.constituencyName}" both resolve to DB constituency "${db.name}". Aborting, nothing written.`);
    claimed.set(db.id, r.constituencyName);
    resolved.push({ csv: r, db });
  }

  if (misses.length) {
    console.error(`\nUNRESOLVED by name (${misses.length}) — aborting, nothing written. Nearest DB candidates shown:`);
    for (const m of misses) {
      const mk = norm(m.constituencyName);
      const suggestions = constituencies
        .filter((c) => {
          const ck = norm(c.name);
          return ck.startsWith(mk.slice(0, 5)) || mk.startsWith(ck.slice(0, 5)) || ck.includes(mk.slice(0, 6)) || mk.includes(ck.slice(0, 6));
        })
        .map((c) => c.name)
        .slice(0, 4);
      console.error(`  CSV "${m.constituencyName}" (csvId ${m.csvId})  →  candidates: ${suggestions.join(" | ") || "(none found)"}`);
    }
    throw new Error(`${misses.length} CSV rows could not be resolved by name. Paste this output back; each gets an explicit NAME_ALIASES entry — never a guess.`);
  }
  console.log(`Name resolution: 276/276 ✔ (no double-assignments)`);

  // Informational cross-check: where does the CSV numbering diverge from legacyConstId?
  const idDivergent = resolved.filter(({ csv, db }) => db.legacyConstId !== null && db.legacyConstId !== csv.csvId);
  console.log(`legacyConstId cross-check: ${resolved.length - idDivergent.length}/276 agree; ${idDivergent.length} divergent (informational only — name is the join key):`);
  for (const d of idDivergent) console.log(`  ${d.db.name}: csvId=${d.csv.csvId} vs legacyConstId=${d.db.legacyConstId}`);
  console.log();

  const regByConstituencyId = new Map<string, number>(resolved.map(({ csv, db }) => [db.id, csv.registeredVoters]));

  // ── Existing 2024 results, both races, fetched ONCE ──
  const existingResults = await prisma.constituencyResult.findMany({
    where: { electionId: election.id, electionType: { in: [ElectionType.PRESIDENTIAL, ElectionType.PARLIAMENTARY] } },
    select: { id: true, electionType: true, constituencyId: true, totalCast: true, registeredVoters: true },
  });
  const presByConst = new Map(existingResults.filter((r) => r.electionType === "PRESIDENTIAL").map((r) => [r.constituencyId, r]));
  const parlByConst = new Map(existingResults.filter((r) => r.electionType === "PARLIAMENTARY").map((r) => [r.constituencyId, r]));
  console.log(`Existing 2024 results — PRESIDENTIAL: ${presByConst.size} (expect 276), PARLIAMENTARY: ${parlByConst.size} (expect 276)`);

  // ── Both races must be fully present: 276/276 each (Ablekuma North's
  // presidential placeholder row exists — verified 16 Jul 2026) ──
  const presMissing = resolved.filter(({ db }) => !presByConst.has(db.id));
  const parlMissing = resolved.filter(({ db }) => !parlByConst.has(db.id));
  if (presMissing.length !== 0 || parlMissing.length !== 0) {
    if (presMissing.length) console.error("PRESIDENTIAL rows missing from DB:", presMissing.map((m) => m.db.name));
    if (parlMissing.length) console.error("PARLIAMENTARY rows missing from DB:", parlMissing.map((m) => m.db.name));
    throw new Error("Expected all 276 rows present for BOTH races. Aborting, nothing written.");
  }
  console.log(`Coverage confirmed: PRESIDENTIAL 276/276 ✔, PARLIAMENTARY 276/276 ✔`);

  // Informational: confirm the Ablekuma North presidential row is still the
  // expected null-votes DISPUTED placeholder before updating it.
  const anConst = resolved.find(({ db }) => norm(db.name) === "ABLEKUMANORTH");
  if (!anConst) throw new Error("Ablekuma North not found among resolved constituencies. Aborting.");
  const anPres = presByConst.get(anConst.db.id)!;
  console.log(
    `Ablekuma North presidential row: totalCast=${anPres.totalCast}, prior registeredVoters=${anPres.registeredVoters} — will receive registeredVoters=${anConst.csv.registeredVoters.toLocaleString()}; turnoutPct/notes/status/source untouched\n`
  );

  // ── Phase 1: constituency-level updates ──
  console.log("── Phase 1: ConstituencyResult updates ──");
  let overwrittenNonNull = 0;
  const buildUpdates = (byConst: Map<string, { id: string; totalCast: number | null; registeredVoters: number | null }>) => {
    const ops: Prisma.PrismaPromise<unknown>[] = [];
    for (const [constituencyId, reg] of regByConstituencyId) {
      const row = byConst.get(constituencyId);
      if (!row) continue; // unreachable after the 276/276 coverage assertion above
      if (row.registeredVoters !== null && row.registeredVoters !== reg) overwrittenNonNull++;
      const t = turnout(row.totalCast, reg);
      ops.push(
        prisma.constituencyResult.update({
          where: { id: row.id },
          data: { registeredVoters: reg, ...(t !== undefined ? { turnoutPct: t } : {}) },
        })
      );
    }
    return ops;
  };

  await runChunkedTransactions(buildUpdates(presByConst), "PRESIDENTIAL updates (276, incl. Ablekuma North placeholder)");
  await runChunkedTransactions(buildUpdates(parlByConst), "PARLIAMENTARY updates (276)");
  if (overwrittenNonNull > 0) console.log(`  Note: ${overwrittenNonNull} rows had a different non-null registeredVoters before this seed (now overwritten with EC register).`);

  // ── Phase 2 (opt-in): Regional/National aggregates ──
  if (WITH_AGGREGATES) {
    console.log("── Phase 2: RegionalResult / NationalResult aggregates ──");
    const regTotalByRegionId = new Map<string, number>();
    for (const { csv, db } of resolved) {
      regTotalByRegionId.set(db.regionId, (regTotalByRegionId.get(db.regionId) ?? 0) + csv.registeredVoters);
    }
    console.log(`  Region sums computed for ${regTotalByRegionId.size} regions (expect 16)`);

    const regionalRows = await prisma.regionalResult.findMany({
      where: { electionId: election.id, electionType: { in: [ElectionType.PRESIDENTIAL, ElectionType.PARLIAMENTARY] } },
      select: { id: true, regionId: true, electionType: true, totalCast: true },
    });
    const regionalOps: Prisma.PrismaPromise<unknown>[] = [];
    for (const row of regionalRows) {
      const reg = regTotalByRegionId.get(row.regionId);
      if (reg === undefined) continue;
      const t = turnout(row.totalCast, reg);
      regionalOps.push(
        prisma.regionalResult.update({
          where: { id: row.id },
          data: { registeredVoters: reg, ...(t !== undefined ? { turnoutPct: t } : {}) },
        })
      );
    }
    await runChunkedTransactions(regionalOps, `RegionalResult updates (found ${regionalRows.length} rows for 2024)`);

    const nationalRows = await prisma.nationalResult.findMany({
      where: { electionId: election.id, electionType: { in: [ElectionType.PRESIDENTIAL, ElectionType.PARLIAMENTARY] } },
      select: { id: true, electionType: true, totalCast: true },
    });
    const nationalOps: Prisma.PrismaPromise<unknown>[] = [];
    for (const row of nationalRows) {
      const t = turnout(row.totalCast, csvTotal);
      nationalOps.push(
        prisma.nationalResult.update({
          where: { id: row.id },
          data: { registeredVoters: csvTotal, ...(t !== undefined ? { turnoutPct: t } : {}) },
        })
      );
    }
    await runChunkedTransactions(nationalOps, `NationalResult updates (found ${nationalRows.length} rows for 2024)`);
    console.log();
  }

  // ── Verification pass — read back and report ──
  console.log("── Verification ──");
  const verify = await prisma.constituencyResult.groupBy({
    by: ["electionType"],
    where: { electionId: election.id, electionType: { in: [ElectionType.PRESIDENTIAL, ElectionType.PARLIAMENTARY] }, registeredVoters: { not: null } },
    _count: { _all: true },
    _sum: { registeredVoters: true },
  });
  for (const v of verify) {
    console.log(`  ${v.electionType}: ${v._count._all} rows with registeredVoters, sum = ${v._sum.registeredVoters?.toLocaleString()} (expect 276 / 18,760,371 each)`);
  }
  console.log("\n── Seed 14 complete ──");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
