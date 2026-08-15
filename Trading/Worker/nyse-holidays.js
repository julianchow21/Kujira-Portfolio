// ===========================================================================
// NYSE holidays and half-days — SINGLE source of truth, shared by:
//   - the Cloudflare Worker (esm import, see MU Yahoo Worker v3 isMarketWindow)
//   - the dashboard frontend (loaded as a module script in index.html that
//     assigns window.KjrNyse; the market clock reads it lazily)
// Extend these lists with the next year's dates before 2028 lapses, otherwise
// every US market holiday after the last listed year is treated as a trading
// day (market clock will be wrong, and Worker alerts fire on a flat tape).
// Source: official NYSE Group holiday and early-closings press release.
// ===========================================================================

export const NYSE_HOLIDAYS = new Set([
  "2026-01-01","2026-01-19","2026-02-16","2026-04-03",
  "2026-05-25","2026-07-03","2026-09-07","2026-11-26","2026-12-25",
  "2027-01-01","2027-01-18","2027-02-15","2027-03-26",
  "2027-05-31","2027-06-18","2027-07-05","2027-09-06","2027-11-25","2027-12-24",
  "2028-01-17","2028-02-21","2028-04-14",
  "2028-05-29","2028-06-19","2028-07-04","2028-09-04","2028-11-23","2028-12-25",
]);

export const NYSE_HALF_DAYS = new Set([
  "2026-07-02","2026-11-27","2026-12-24",
  "2027-11-26",
  "2028-07-03","2028-11-24",
]);
