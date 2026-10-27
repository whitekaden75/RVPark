import { createHash } from 'node:crypto';
import { bookkeepingRoutes } from './bookkeeping-http.js';

const date = value => value instanceof Date ? value.toISOString().slice(0, 10) : String(value || '').slice(0, 10);
const normalize = value => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const vendor = row => normalize(row.vendor).replace(/\b(the|inc|llc|ltd|corp)\b/g, '').replace(/\s+/g, ' ').trim();
const currency = row => String(row.currency || 'USD').toUpperCase();
const cents = row => Math.round(Number(row.total) * 100);
const statement = row => ['bank_statement', 'credit_card_statement'].includes(row.document_type);
const receipt = row => ['receipt', 'invoice'].includes(row.document_type) || row.document_id == null;
const valid = row => /^\d{4}-\d{2}-\d{2}$/.test(date(row.transaction_date)) && Number.isFinite(Date.parse(date(row.transaction_date))) && Number.isSafeInteger(cents(row)) && cents(row) > 0 && vendor(row);
const bucket = row => `${currency(row)}|${row.transaction_type}`;
const account = row => normalize(row.payment_account);
const accountCompatible = (a, b) => {
  const last4 = row => String(row.payment_account || '').match(/\d{4}(?!.*\d)/)?.[0];
  return !last4(a) || !last4(b) || last4(a) === last4(b);
};
const distance = (a, b) => Math.abs(Date.parse(date(a.transaction_date)) - Date.parse(date(b.transaction_date))) / 86400000;
const similarVendor = (a, b) => {
  const left = new Set(vendor(a).split(' ').filter(word => word.length > 2));
  const right = new Set(vendor(b).split(' ').filter(word => word.length > 2));
  return !!vendor(a) && (vendor(a) === vendor(b) || [...left].some(word => right.has(word)));
};

// The fingerprint covers the full input, including edits, new imports, and undo operations.
export function reconciliationSnapshot(rows, links, bills) {
  return createHash('sha256').update(JSON.stringify({ rows, links, bills })).digest('hex');
}

export function auditBookkeeping(rows, links = [], bills = []) {
  const byId = new Map(rows.map(row => [String(row.id), row]));
  const parents = new Map(links.filter(link => link.keeper_transaction_id).map(link => [String(link.duplicate_transaction_id), String(link.keeper_transaction_id)]));
  const protectedIds = new Set([...links.map(link => String(link.keeper_transaction_id)), ...bills.map(bill => String(bill.paid_transaction_id))]);
  const resolve = id => {
    const visited = new Set();
    while (parents.has(id) && !visited.has(id)) { visited.add(id); id = parents.get(id); }
    return id;
  };
  let groups = new Map(rows.filter(row => row.status !== 'void').map(row => [String(row.id), { root: row, evidence: [row] }]));
  for (const row of rows.filter(row => row.status === 'void')) {
    const root = groups.get(resolve(String(row.id)));
    if (root) root.evidence.push(row);
  }
  const actions = [], duplicates = [];
  const prefer = (a, b) => Number(protectedIds.has(String(b.id))) - Number(protectedIds.has(String(a.id))) || Number(b.status === 'approved') - Number(a.status === 'approved') || Number(receipt(b)) - Number(receipt(a)) || String(a.id).localeCompare(String(b.id), 'en', { numeric: true });
  function merge(left, right, reason) {
    const [keeper, duplicate] = [left.root, right.root].sort(prefer);
    if (protectedIds.has(String(duplicate.id)) || (duplicate.status === 'approved' && keeper.status !== 'approved')) return false;
    const kept = groups.get(String(keeper.id)), removed = groups.get(String(duplicate.id));
    actions.push({ duplicateId: duplicate.id, keeperId: keeper.id, reason });
    parents.set(String(duplicate.id), String(keeper.id));
    kept.evidence.push(...removed.evidence);
    groups.delete(String(duplicate.id));
    return true;
  }
  const facet = (group, predicate) => group.evidence.find(predicate);
  // Overlapping statements can be collapsed only with an explicit identical account.
  // Multiple identical purchases within either document remain ambiguous.
  const statementBuckets = new Map();
  for (const group of groups.values()) {
    const row = facet(group, statement);
    if (!row || !valid(row)) continue;
    const key = [date(row.transaction_date), cents(row), bucket(row), vendor(row), account(row)].join('|');
    const items = statementBuckets.get(key) || [];
    items.push({ group, row }); statementBuckets.set(key, items);
  }
  for (const items of statementBuckets.values()) {
    if (items.length < 2) continue;
    items.sort((a, b) => prefer(a.group.root, b.group.root));
    const sourceDocuments = items.flatMap(item => item.group.evidence.filter(statement).map(row => String(row.document_id)));
    const uniqueDocuments = new Set(sourceDocuments).size === sourceDocuments.length;
    const first = items[0];
    for (const item of items.slice(1)) {
      const sameSource = first.row.document_type === item.row.document_type;
      const eligible = !!account(first.row) && uniqueDocuments && sameSource;
      const original = groups.get(resolve(String(first.group.root.id)));
      const duplicate = groups.get(resolve(String(item.group.root.id)));
      const reason = eligible ? 'Overlapping statements: same account, merchant, date, amount, currency and type.' : 'Repeated statement entry. Verify the account and whether these are separate purchases.';
      const applied = eligible && merge(original, duplicate, reason);
      duplicates.push({ source: 'statement', original: original.root, duplicate: duplicate.root, statementDocumentIds: [first.row.document_id, item.row.document_id], reason, canAutoConsolidate: !!applied });
    }
  }
  // Receipt-only duplicates are review items: identical purchases can be real.
  const receiptBuckets = new Map();
  for (const group of groups.values()) {
    const row = facet(group, receipt);
    if (!row || !valid(row)) continue;
    const key = [date(row.transaction_date), cents(row), bucket(row), vendor(row)].join('|');
    const items = receiptBuckets.get(key) || []; items.push(group); receiptBuckets.set(key, items);
  }
  for (const items of receiptBuckets.values()) {
    items.sort((a, b) => prefer(a.root, b.root));
    for (const item of items.slice(1)) duplicates.push({ source: 'receipt', original: items[0].root, duplicate: item.root, reason: 'Same merchant, date and amount on multiple receipt/manual entries. Verify before removing a real purchase.', canAutoConsolidate: false });
  }

  const statementGroups = [...groups.values()].filter(group => facet(group, statement) && !facet(group, receipt));
  const receiptGroups = [...groups.values()].filter(group => facet(group, receipt) && !facet(group, statement));
  const candidates = new Map(), reverse = new Map(), receiptIndex = new Map();
  for (const group of receiptGroups) {
    const row = facet(group, receipt);
    if (!valid(row)) continue;
    // Index by currency/type and day to avoid comparing every historical pair.
    const key = `${bucket(row)}|${date(row.transaction_date)}`;
    const items = receiptIndex.get(key) || []; items.push(group); receiptIndex.set(key, items);
  }
  for (const group of statementGroups) {
    const row = facet(group, statement), options = [];
    if (valid(row)) for (let offset = -3; offset <= 3; offset++) {
      const day = new Date(Date.parse(date(row.transaction_date)) + offset * 86400000).toISOString().slice(0, 10);
      for (const other of receiptIndex.get(`${bucket(row)}|${day}`) || []) {
        const otherRow = facet(other, receipt);
        if (!accountCompatible(row, otherRow)) continue;
        const equalAmount = cents(row) === cents(otherRow);
        if (!equalAmount && !similarVendor(row, otherRow)) continue;
        const exactVendor = vendor(row) === vendor(otherRow);
        const option = { group: other, row: otherRow, equalAmount, exactVendor, distance: distance(row, otherRow) };
        options.push(option);
        if (equalAmount && exactVendor) {
          const items = reverse.get(String(other.root.id)) || []; items.push(group); reverse.set(String(other.root.id), items);
        }
      }
    }
    candidates.set(String(group.root.id), options);
  }
  const possibleMatches = [], unmatchedStatement = [], usedReceipts = new Set();
  for (const group of statementGroups) {
    const row = facet(group, statement), options = candidates.get(String(group.root.id));
    const strong = options.filter(option => option.equalAmount && option.exactVendor);
    const best = [...options].sort((a, b) => Number(b.equalAmount) - Number(a.equalAmount) || Number(b.exactVendor) - Number(a.exactVendor) || a.distance - b.distance)[0];
    const unique = strong.length === 1 && reverse.get(String(strong[0].group.root.id))?.length === 1;
    if (unique && ['expense', 'income', 'refund'].includes(row.transaction_type) && merge(group, strong[0].group, 'Statement and receipt: unique merchant, amount, currency and type within 3 days.')) {
      usedReceipts.add(String(strong[0].group.root.id));
      continue;
    }
    const reason = !valid(row) ? 'Missing or invalid date, merchant or positive amount. Review the extracted transaction.' : !best ? 'No receipt found within 3 days for this amount, currency and transaction type.' : !best.equalAmount ? 'Merchant and date are similar, but amounts differ. Check the receipt total, tax, tips, or extraction.' : strong.length > 1 || (strong.length && !unique) ? 'Several records could represent this purchase. Choose the correct pair manually.' : 'Possible match. Verify the merchant, date and transaction type.';
    const result = { statementTransaction: row, receiptTransaction: best?.row || null, status: best ? 'possible_match' : 'unmatched_statement', details: { reason }, amountDifference: best ? (cents(row) - cents(best.row)) / 100 : null };
    (best ? possibleMatches : unmatchedStatement).push(result);
  }
  const matched = [...groups.values()].filter(group => facet(group, statement) && facet(group, receipt)).map(group => ({
    statementTransaction: facet(group, statement), statementEvidence: group.evidence.filter(statement), receiptTransaction: facet(group, receipt), keeperTransaction: group.root,
    status: actions.some(action => resolve(String(action.keeperId)) === String(group.root.id)) ? 'suggested' : 'connected',
    details: { reason: 'Statement and receipt evidence are connected; only the kept transaction enters totals when approved.' },
  }));
  const stripeLinks = new Set(links.filter(link => link.stripe_activity_id).map(link => String(link.duplicate_transaction_id)));
  const connectedStripe = rows.filter(row => stripeLinks.has(String(row.id)) && statement(row));
  const unmatchedReceipts = receiptGroups.filter(group => !usedReceipts.has(String(group.root.id))).map(group => ({ ...facet(group, receipt), reconciliation_reason: valid(facet(group, receipt)) ? 'No confirmed statement match. Check possible matches or upload the missing statement.' : 'Missing or invalid date, merchant or positive amount. Review this transaction.' }));
  const otherTransactions = [...groups.values()].filter(group => !facet(group, statement) && !facet(group, receipt)).map(group => group.root);
  const totals = new Map();
  for (const group of groups.values()) for (const [predicate, field] of [[statement, 'statementTotal'], [receipt, 'receiptTotal']]) {
    const row = facet(group, predicate);
    if (!row) continue;
    const key = bucket(row), item = totals.get(key) || { currency: currency(row), type: row.transaction_type, statementTotal: 0, receiptTotal: 0 };
    item[field] += Number.isSafeInteger(cents(row)) ? cents(row) : 0; totals.set(key, item);
  }
  const cleanup = actions.map(action => ({ ...action, keeperId: byId.get(resolve(String(action.keeperId))).id, duplicate: byId.get(String(action.duplicateId)), keeper: byId.get(resolve(String(action.keeperId))) }));
  return {
    snapshot: reconciliationSnapshot(rows, links, bills), scope: 'all', scannedCount: rows.filter(row => row.status !== 'void').length,
    matched, possibleMatches, unmatchedStatement, unmatchedReceipts, duplicates, otherTransactions, connectedStripe, cleanup,
    totals: [...totals.values()].map(row => ({ ...row, statementTotal: row.statementTotal / 100, receiptTotal: row.receiptTotal / 100, difference: (row.statementTotal - row.receiptTotal) / 100 })),
  };
}

export async function loadBookkeepingAudit(client) {
  const rows = await client.query(`SELECT t.*,d.document_type,d.original_filename AS source_filename FROM bookkeeping_transactions t LEFT JOIN bookkeeping_documents d ON d.id=t.document_id ORDER BY t.id`);
  const links = await client.query('SELECT * FROM bookkeeping_consolidations ORDER BY id');
  const bills = await client.query("SELECT id,paid_transaction_id FROM bookkeeping_bills WHERE status='paid' ORDER BY id");
  return auditBookkeeping(rows.rows, links.rows, bills.rows);
}

// A statement view uses the global assignment, so another statement cannot claim
// the same receipt and confirmed links remain visible after consolidation.
export function statementAudit(report, documentId, statementRows) {
  const belongs = row => String(row.document_id) === String(documentId);
  const dates = statementRows.map(row => date(row.transaction_date)).filter(value => /^\d{4}-\d{2}-\d{2}$/.test(value)).sort();
  const start = Date.parse(dates[0]) - 3 * 86400000, end = Date.parse(dates.at(-1)) + 3 * 86400000;
  return {
    ...report, scope: 'statement', cleanup: [], totals: [], otherTransactions: [],
    matched: report.matched.filter(row => row.statementEvidence.some(belongs)).map(row => ({ ...row, statementTransaction: row.statementEvidence.find(belongs) })),
    possibleMatches: report.possibleMatches.filter(row => belongs(row.statementTransaction)),
    unmatchedStatement: report.unmatchedStatement.filter(row => belongs(row.statementTransaction)),
    unmatchedReceipts: report.unmatchedReceipts.filter(row => Date.parse(date(row.transaction_date)) >= start && Date.parse(date(row.transaction_date)) <= end),
    duplicates: report.duplicates.filter(row => belongs(row.original) || belongs(row.duplicate) || row.statementDocumentIds?.some(id => String(id) === String(documentId))),
    connectedStripe: report.connectedStripe.filter(belongs),
  };
}

export function registerBookkeepingAuditRoutes(app, { pool, notify = () => {} }) {
  const routes = bookkeepingRoutes(app);
  routes.get('/api/bookkeeping/reconciliation', async (_req, res) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const report = await loadBookkeepingAudit(client);
      await client.query('COMMIT');
      res.json(report);
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    finally { client.release(); }
  });
  routes.post('/api/bookkeeping/reconciliation/cleanup', async (req, res) => {
    if (!/^[a-f0-9]{64}$/.test(req.body?.snapshot || '')) return res.status(400).json({ message: 'Scan all transactions before consolidating.' });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Keep the plan stable while checking it and writing the reversible exclusions.
      await client.query("SET LOCAL lock_timeout = '5s'");
      await client.query('LOCK TABLE bookkeeping_transactions, bookkeeping_documents, bookkeeping_consolidations, bookkeeping_bills IN SHARE ROW EXCLUSIVE MODE');
      const report = await loadBookkeepingAudit(client);
      if (report.snapshot !== req.body.snapshot) throw Object.assign(new Error('Transactions changed since this scan. Scan again to review the latest matches.'), { statusCode: 409 });
      for (const action of report.cleanup) {
        await client.query(`INSERT INTO bookkeeping_consolidations (duplicate_transaction_id,keeper_transaction_id,previous_status,reason,created_by_admin_user_id) VALUES ($1,$2,$3,$4,$5)`, [action.duplicateId, action.keeperId, action.duplicate.status, `Automatic reconciliation: ${action.reason}`, req.adminUser.id]);
        await client.query("UPDATE bookkeeping_transactions SET status='void' WHERE id=$1", [action.duplicateId]);
      }
      const updated = await loadBookkeepingAudit(client);
      await client.query('COMMIT');
      if (report.cleanup.length) notify({ reason: 'bookkeeping_changed' });
      res.json({ consolidatedCount: report.cleanup.length, report: updated });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      if (['55P03', '40P01'].includes(error.code)) throw Object.assign(new Error('Bookkeeping is being updated. Wait a moment, then scan again.'), { statusCode: 409 });
      throw error;
    } finally { client.release(); }
  });
}
