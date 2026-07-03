# Seed Data Corrections Log

Deviations from legacy source, applied during migration. Everything else is verbatim.

| # | Where | Legacy value | Corrected to | Reason |
|---|-------|--------------|--------------|--------|
| 1 | elections.parliament_label (2024) | Nineth Parliament | Ninth Parliament | Spelling |
| 2 | parties.name (URP) | United Rennaisance Party | United Renaissance Party | Spelling |
| 3 | candidates (presidential, 1996–2004) | John Agyekum Kuffuor | John Agyekum Kufuor | Official spelling |
| 4 | candidates (presidential, 2000) | Prof. George Haggan | Prof. George Hagan | Official spelling |
| 5 | candidates (presidential, 2000) | Augustus Obuadum Goosie Tannoh | Augustus Obuadum Goosie Tanoh | Official spelling |
| 6 | candidates (parliamentary) | 4 ages below 21 | age set to NULL | Below constitutional MP minimum; entry errors |
| 7 | candidates (parliamentary) | 2 exact duplicate rows | deduplicated | Duplicate entries (2000: Joseph Baah; John K. Assifuah-Nunoo) |

Held out of Seed 02 (deferred to 2016/2020/2024 completion workstream):
- 2016 presidential candidate list — legacy rows are a clone of the 2012 lineup and do not match the actual 2016 EC ballot.
- 2016 partial results (37 constituencies presidential, 26 parliamentary rows).

© 2026 AIEI / Ayivi Solutions Limited
