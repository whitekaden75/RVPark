# Reservation balance audit — October 27, 2026

Checked a read-only snapshot of 1,008 non-canceled, uncombined reservations from the configured database. No reservation, payment, waiver, or guest message was changed. Compared the original and corrected production calculation functions against the same saved records.

## Findings

1. **The schedule discarded payment history.** `reservations.id` is returned as a JavaScript number, while `reservation_payment_events.reservation_id` is returned as a string. The schedule grouped payments under string keys and looked them up under number keys. It attached zero of the 782 available payment-history rows. The booking detail loader used a direct query and did not have this lookup problem. Without the history, the schedule guessed whether paid amounts represented cash/bank or card nights, often leaving an invented $1.99–$3.98 balance after mixed payments.

2. **Untyped historical payments could invent fees during allocation.** For older events without a recorded price type, each fragment was guessed separately. Even when the saved aggregate exactly matched the full bank total, an early fragment could be assigned the card price and create an unpaid remainder. The corrected allocator uses the exactly matching full total consistently when all events lack an explicit type. Explicit bank/card price types still take precedence, and partial payments receive no automatic write-off.

## Corrections verified

- Normalized reservation, payment, stay, and check-in lookup keys in the schedule loader.
- Confirmed schedule and detail calculations agree for numeric/string ID combinations, fully paid mixed tenders, and genuinely partial payments.
- Preserved actual `amount_paid`, payment events, booked prices, and price differences for explicit card payments and site upgrades.
- 56 reservations with false schedule balances now calculate $0 owed and zero unpaid nights.
- 18 additional historical reservations with false detail balances now calculate $0 owed.
- 74 distinct reservations are corrected across those two cases.

### Examples from the schedule

| Reservation | Saved amount paid | Old card balance | Corrected bank/card balance |
| --- | ---: | ---: | ---: |
| #906 | $215.98 | $2.99 | $0.00 |
| #1072 | $131.99 | $1.99 | $0.00 |
| #1079 | $142.99 | $2.99 | $0.00 |
| #1109 | $515.92 | $3.98 | $0.00 |

### All schedule balances cleared

#19, #30, #67, #87, #106, #111, #114, #124, #149, #151, #152, #182, #183, #192, #218, #221, #224, #225, #228, #235, #236, #237, #238, #241, #372, #392, #476, #532, #533, #534, #545, #568, #592, #609, #629, #637, #638, #642, #663, #674, #713, #720, #727, #728, #730, #759, #798, #850, #896, #906, #912, #938, #955, #1072, #1079, #1109

### Historical detail balances cleared

#93, #408, #442, #445, #459, #474, #538, #601, #617, #707, #794, #820, #837, #842, #851, #852, #854, #866

## Remaining small balances for review

These two records still calculate a card balance under $10 because their payment history explicitly specifies card pricing. They were not silently waived. The following figures reflect current saved pricing, not a conclusion about what staff originally agreed to accept.

| Reservation | Saved paid | Current card total | Current card balance | Review item |
| --- | ---: | ---: | ---: | --- |
| #873 | $60.00 | $61.99 | $1.99 | The $60 payment is explicitly marked card. Confirm whether $60 was accepted as the final agreed price. |
| #1016 | $464.95 | $467.94 | $2.99 | Card payments are recorded, but the site and dates differ from the original checkout. Confirm the agreed price after the change. |

Attaching the previously missing explicit payment history also exposes larger calculated differences on #345 ($47.76 card), #370 ($20.93 card), and #1021 ($373.93 card). Those should be reviewed against the agreed stay price and historical adjustments rather than erased. No amounts were changed.

## Validation and release status

Both new regression cases failed before the fixes and passed after them. The full server suite passed 119 tests with one unrelated optional PostgreSQL SMS test skipped; all 19 client tests passed. The server source passes `node --check`, and the diff passes whitespace checks.

The fixes are local source changes and require deployment of the server to affect the live site. No database migration or paid-amount rewrite is required.
