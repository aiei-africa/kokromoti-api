import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

// Correction verified directly against the original EC Form Ten pink sheet
// (C10-0017, Okaikwei North, Greater Accra) — the source CSV had a cascading
// row-misalignment affecting five candidates and dropped Kyerematen's row
// entirely. Every figure below is read straight off the actual scanned
// declaration form, cross-checked against the stated Total Valid Votes
// (49,368) as the reconciliation anchor: sum matches exactly, and
// 49,368 + 474 rejected = 49,842 total cast, matching the form's own totals.
const CORRECT_VOTES: Record<string, number> = {
  "Mahamudu Bawumia": 18890,
  "Daniel Augustus Lartey Jnr": 13,
  "Akua Donkor": 0,
  "Christian Kwabena Andrews": 36,
  "Kofi Akpaloo": 4,
  "Mohammed Frimpong": 4,
  "Nana Akosua Frimpomaa": 62,
  "John Dramani Mahama": 29710,
  "Hassan Abdulai Ayariga": 17,
  "Kofi Koranteng": 5,
  "George Twum-Barimah-Adu": 0,
  "Nana Kwame Bediako": 497,
  "Alan John Kwadwo Kyerematen": 130,
};

const CORRECTION_NOTE =
  "CORRECTED against the original EC Form Ten pink sheet (C10-0017, Okaikwei North, Greater Accra), verified 2026-07-06. " +
  "The source CSV had a cascading figure misalignment: Frimpong was shown as 62 (actually Frimpomaa's corrected figure — her original 29,710 was crossed out on the form and corrected to 62, confirmed by her own words column reading SIXTY-TWO); " +
  "Mahama was shown as 17 (actually Ayariga's figure); Ayariga was shown as 5 (actually Koranteng's figure); Koranteng was shown as 0; and Kyerematen's row (130 votes) was dropped from the extraction entirely, though it is present on the actual form. " +
  "All 13 figures below are read directly from the pink sheet and reconcile exactly: candidate sum = 49,368 = stated Total Valid Votes; 49,368 + 474 rejected = 49,842 = stated Total Votes Cast.";

async function main() {
  const election = await prisma.election.findFirst({ where: { code: "2024" } });
  if (!election) throw new Error("2024 election not found");

  const constituency = await prisma.constituency.findFirst({ where: { name: { equals: "Okaikwei North", mode: "insensitive" } } });
  if (!constituency) throw new Error("Okaikwei North not found in constituency table");

  const result = await prisma.constituencyResult.findFirst({
    where: { electionId: election.id, electionType: "PRESIDENTIAL", constituencyId: constituency.id },
  });
  if (!result) throw new Error("No existing ConstituencyResult found for Okaikwei North — expected one from Seed 09");

  const existingVotes = await prisma.constituencyResultVote.findMany({
    where: { constituencyResultId: result.id },
    include: { candidate: { select: { fullName: true } } },
  });
  console.log(`Existing vote rows found: ${existingVotes.length}`);

  // Delete the incorrect votes and rebuild with verified figures
  await prisma.constituencyResultVote.deleteMany({ where: { constituencyResultId: result.id } });

  const candidates = await prisma.candidate.findMany({
    where: { electionId: election.id, electionType: "PRESIDENTIAL" },
  });
  const candidateIdByName = new Map(candidates.map((c) => [c.fullName, c.id]));

  const validVotes = 49368;
  const voteRows = Object.entries(CORRECT_VOTES).map(([name, votes]) => ({
    constituencyResultId: result.id,
    candidateId: candidateIdByName.get(name)!,
    votes,
    voteShare: Number(((votes / validVotes) * 100).toFixed(4)),
  }));

  const checksum = voteRows.reduce((s, v) => s + v.votes, 0);
  console.log(`Checksum: ${checksum} (expect 49368)`);
  if (checksum !== validVotes) throw new Error(`Checksum mismatch — aborting before write. Got ${checksum}, expected ${validVotes}`);

  await prisma.constituencyResultVote.createMany({ data: voteRows });

  await prisma.constituencyResult.update({
    where: { id: result.id },
    data: { notes: CORRECTION_NOTE },
  });

  console.log(`\nOkaikwei North corrected: ${voteRows.length} vote rows written, notes field updated.`);
  console.log("── Correction complete ──");
}

main().catch(console.error).finally(() => prisma.$disconnect());
