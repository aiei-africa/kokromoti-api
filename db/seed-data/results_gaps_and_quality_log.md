# Kokromoti Results Migration — Data Quality & Gaps Log

## 1992 — provisional, non-gazetted status

1992 election data in this source is EC-compiled from secondary sources,
NOT the gazetted primary record. Real gazetted data begins 1996. Per
standing instruction, 1992 data is stored as-is for reference and
fact-checking purposes, to be reviewed against the real gazette later.

**Presidential 1992 (200 constituencies):** registered voters recorded;
cast/rejected/valid/candidate votes are 0 in the source across the board.
Stored as constituency_results rows with registeredVoters populated and
no vote lines attached — not fabricated, not estimated, exactly what the
source contains.

**Parliamentary 1992 (177 constituencies):** single uncontested candidate
recorded with a blank vote field; the constituency's total valid-vote
figure was present. Resolved: the uncontested candidate is credited with
the full valid-vote total, consistent with the documented opposition
boycott of the 1992 parliamentary election producing large numbers of
unopposed NDC-aligned wins. Still provisional pending gazette review.

## Other isolated gaps (not 1992-related, genuine source gaps)

**2000 Run-off — 7 constituencies with zero cast votes, excluded:**
Oforikrom, Sene West, Ada, Walewale, Yapei-Kusawgu, Nkwanta South, Juaboso.

**2008 — 1 constituency excluded:** Akwatia (registered 49,203, cast
recorded as 1 — a data entry gap, not a real result).

## Parliamentary reconciliation — 76 flagged discrepancies

Candidate vote sum does not match the reported valid-vote total, by a
non-trivial margin, across multiple elections (1996-2016). NOT
auto-corrected. Candidate-level votes as recorded are carried into the
migration; the discrepancy is logged for manual review against original
pink sheets / EC archives where accuracy matters (see
results_data_quality_flags.json for the full list with exact figures).

## Verification passed

**Presidential vote counts, 1996-2012: 6,960 candidate-constituency vote
figures checked against the independent fact_presidential_const_results
table — 6,960 exact matches, 0 discrepancies.** Strongest confidence
signal available in the source material, covering the large majority
of the historical dataset (all gazetted-era elections, 1996 onward).

© 2026 AIEI / Ayivi Solutions Limited