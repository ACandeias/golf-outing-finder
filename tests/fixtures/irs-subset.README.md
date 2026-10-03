# irs-subset.csv: synthetic IRS Business Master File rows

**Synthetic test data. The EINs are made up and do not identify any organization.** Every EIN in
`irs-subset.csv` is in the `99-0000101` to `99-0000122` range, chosen so a fixture value can never
be mistaken for a real one. Do not use them anywhere but tests.

The file has the 28 columns of the IRS Exempt Organizations Business Master File extract
(`eo_xx.csv` from irs.gov), in the same order and with the same header names:
`EIN, NAME, ICO, STREET, CITY, STATE, ZIP, GROUP, SUBSECTION, AFFILIATION, CLASSIFICATION, RULING,
DEDUCTIBILITY, FOUNDATION, ACTIVITY, ORGANIZATION, STATUS, TAX_PERIOD, ASSET_CD, INCOME_CD,
FILING_REQ_CD, PF_FILING_REQ_CD, ACCT_PD, ASSET_AMT, INCOME_AMT, REVENUE_AMT, NTEE_CD, SORT_NAME`.
Names are upper case without punctuation, as in the BMF. `SORT_NAME` holds a secondary name where
the seed uses one (BCNY, Guild Hall, Nu Omicron Chapter).

Rows: one per seed organizer that is a real nonprofit, with subsection `03` (501(c)(3)), plus one
decoy, Builders Institute, with subsection `06` (a trade association) for golden case gc3. Grady
Dad's Club (gc5) and Golf With Access are deliberately absent, so they stay `unverified`.

Where a headquarters sits outside the venue state (Autism Speaks in NJ for a NY outing, the
American Cancer Society in GA for an IL outing, the National Kidney Foundation in NY for a PA
outing), the classifier has to use the nationwide name match at 0.95 or higher (SPEC.md 8.5).

Addresses, amounts and codes other than `SUBSECTION` are plausible filler. The pipeline keeps only
EIN, NAME, CITY, STATE, SUBSECTION (and SORT_NAME as an alias).
