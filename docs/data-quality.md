# Data quality rules

## Product identity and specifications

Use a manufacturer's model number as `model_number`. Keep AHRI identifiers in
`ahri_reference_number`; an AHRI Certified Reference Number identifies a
certified matched system, while SEER2, EER2, and HSPF2 are performance ratings.
For split HVAC, do not assign a rating to an outdoor unit by itself: the rating
belongs to the certified indoor/outdoor combination.

The appliance source table records the source URL and the date checked. ENERGY
STAR imports carry their dataset URL and download date from the manifest.
Prefer ENERGY STAR or manufacturer sources for appliance identity and
performance values.

## Retail prices

The retail scraper accepts an offer only when one result card has all of these:

- the complete model number and brand in the product title;
- exactly one price in the price field;
- a direct Home Depot or Lowe's product URL;
- a fetch timestamp.

The database and API reject incomplete or mismatched rows. The app displays a
price only for seven days after it was fetched, links to the retailer page, and
shows the check date. If the scraper cannot prove a match, it leaves the price
blank.

## Rebate programs

Every active rebate row needs an HTTPS source URL and a `verified_at` date no
more than 90 days old. The database builder skips rows without current source
evidence. The previous rebate amounts and requirements are retained under
`data/sample/` as rule-engine examples and are not loaded into the app.

The program record is intentionally not limited to a cash amount or an income
cap. In `data/raw/rebates.csv`:

- `benefit_type` identifies a benefit such as `cash_rebate`, `bill_credit`,
  `tax_credit`, `discount`, `financing`, or `free_service`.
- `benefit_json` stores the source-described value and shape, such as a total,
  monthly credits, percentage, maximum, currency, cadence, or a display label.
  `amount` is an optional numeric summary for simple comparisons.
- `income_cap` is optional. Leave it blank when the program has no published
  cap; do not invent a high cap to simulate unlimited eligibility.
- `zip_code` accepts an exact ZIP, `*`, or a `*` wildcard (for example `941*`).
  `geography_json` preserves the program's service territory description.
- `eligibility_json` supports `all` and `any` conditions. Each condition has a
  `field`, `operator`, `value`, and a user-facing `question`; optional `type`
  and `options` drive the input form. Operators include `eq`, `neq`, `in`,
  `not_in`, `gte`, `gt`, `lte`, `lt`, `between`, `exists`, and `contains`.
  Criteria can ask about income, utility enrollment, the existing appliance,
  installation date, property, or other program-specific facts. Unknown facts
  are reported as `needs_input`, not as ineligible.
- `valid_from` and `valid_to` represent the offer's active dates. The source
  verification date remains separate from the program period.

Appliance performance conditions can continue to use
`data/raw/rebate_requirements.csv`; its `scope` distinguishes appliance rules.
Use the program JSON for household, property, account, and project conditions.
The reverse search labels catalog products as potential matches and asks users
to verify the provider's final approved-product and installation rules.

The current San Francisco seed entries represent CleanPowerSF bill credits,
not guaranteed cash rebates. Their conditions and credit schedule come from
the official program rules. The checker asks the customer to confirm those
conditions before marking an offer as eligible.

## Refreshing data

Run `npm run fetch:energystar`, `npm run import:energystar`, and
`npm run build:db` to refresh the certified product catalog. Run
`npm run enrich:retail:seed` to look for current retailer offers. Do not add a
price or rebate amount by estimate; add its source URL and verification date.
