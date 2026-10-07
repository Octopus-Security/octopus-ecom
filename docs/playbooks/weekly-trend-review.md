# Weekly trend review

<!-- Generated from server/playbooks/definitions.js by server/playbooks/render-md.js. Edit the definition, not this file. -->

**When to use:** Once a week (about 20 minutes), ideally Monday after the automatic Trends report, before deciding what to design next.

The Trends tab ranks themes by an opportunity score built from sources that cost nothing and break no rules. Two things to hold onto: no source shows other sellers' sales, so every number is a proxy; and the weights behind the score are untested guesses until about 8 to 12 weeks of our own results exist. This list is the human half: the places a person may look but a program must not.

- Pinterest Trends (website): assumed, unverified (Pinterest Trends at https://trends.pinterest.com is described as free for a person to use; its terms on automated access were not read, so ecom never touches it).
- Google Trends website and API alpha: corroborated only (announced 2025-07-24 at https://developers.google.com/search/blog/2025/07/trends-api; the page body was not delivered to the fetch tool, details come from a search-engine-news summary; whether it is still alpha-only on 2026-10-06 is unknown).
- Terapeak in eBay Seller Hub: corroborated only (a summary of eBay making Terapeak free for Seller Hub sellers; eBay's own page was not read). It shows eBay sales only, so it is a cross-check, not our market.
- Do not automate any of these, and do not copy another seller's titles, tags or designs from what you see. Themes, keywords, product types and price bands only.

## Steps

1. [ ] **Open Trends, press Rebuild, read the note at the top and the per-source status line** (`report`)
   A source marked disabled, no data or error is a gap, not a zero. Low-confidence rows (small dot) are guesses.
2. [ ] **Pinterest Trends (website, by hand): check your watchlist themes and the "growing" lists for your categories; enter anything useful under Trends > Manual entries** (`pinterest`)
   assumed, unverified (Pinterest Trends at https://trends.pinterest.com is described as free for a person to use; its terms on automated access were not read, so ecom never touches it)
3. [ ] **Google Trends (website, by hand): compare 3 to 5 themes over 5 years to see their seasonality; type the direction into Manual entries** (`google`)
   A person using the website is fine; automating it (pytrends and similar scrapers) is not, and ecom does not do it.
4. [ ] **Google Trends API alpha: apply through the form linked from the 2025-07 Google developers announcement if you have not, and note the date you applied** (`google-api`)
   corroborated only (announced 2025-07-24 at https://developers.google.com/search/blog/2025/07/trends-api; the page body was not delivered to the fetch tool, details come from a search-engine-news summary; whether it is still alpha-only on 2026-10-06 is unknown)
5. [ ] **Terapeak (eBay Seller Hub > Research), only if you also sell on eBay: look up one or two keywords for sold prices as a cross-check** (`terapeak`)
   corroborated only (a summary of eBay making Terapeak free for Seller Hub sellers; eBay's own page was not read). It shows eBay sales only, so it is a cross-check, not our market
6. [ ] **Redbubble and Amazon Merch: glance at the trending sort and popular searches yourself; enter themes (never listings) in Manual entries** (`redbubble`)
   Their rules reportedly forbid bots (docs/CHANNELS.md); a person looking is fine.
7. [ ] **If you pay for eRank, Alura or EverBee, export a keyword CSV and import it (Trends > CSV import > Preview > Import)** (`csv`)
   The headers are assumed; read the preview mapping before importing. These are the tool's estimates, not Etsy data.
8. [ ] **Check the blocklist section: a hot term removed for brand or franchise reasons stays removed** (`blocklist`)
   Trends inform theme and keyword only. Never reproduce a competitor's design or listing.
9. [ ] **Seasonal windows: for each window closing soon, decide design, list or skip, and write the last-order date where customers see it** (`windows`)
   Last-order dates are estimates from our own lead-time table; replace them with this year's provider and carrier cut-offs (seasonal-prep playbook).
10. [ ] **Gaps: pick up to three high-score themes with nothing in the catalogue and start a small batch (3 to 5 designs) to test the hypothesis** (`gaps`)
11. [ ] **Our launches: look at the score each launch had against its views and sales; note anything the score got badly wrong** (`launches`)
   This is the data for re-fitting the weights after 8 to 12 weeks.
12. [ ] **If the Etsy market source is still off: have you read Etsy's current API Terms and decided? Record the date and the answer in docs/COMPLIANCE.md** (`etsy-terms`)
   assumed, unverified: the terms may require Etsy's authorisation for analytics use; search summaries suggest so, the page itself was not readable.

Policy claims above say `verified 2026-10-05 - <url>` only where that page was read; anything else is `assumed, unverified`.
