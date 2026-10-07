import { bookkeepingRoutes } from './bookkeeping-http.js';
const pacificDate = value => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value));
export const cents = value => Math.round(Number(value || 0) * 100);
const money = value => Math.round(value) / 100;
const isoDate = value => value instanceof Date ? value.toISOString().slice(0, 10) : String(value || '').slice(0, 10);

export function financePeriod(query = {}) {
  const today = pacificDate(Date.now());
  const from = String(query.from || `${today.slice(0, 7)}-01`);
  const to = String(query.to || today);
  const valid = value => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
  if (!valid(from) || !valid(to) || from > to) throw Object.assign(new Error('Choose a valid start and end date.'), { statusCode: 400 });
  if ((Date.parse(to) - Date.parse(from)) / 86400000 > 366) throw Object.assign(new Error('Choose a period of one year or less.'), { statusCode: 400 });
  return { from, to };
}

// Transfers and payouts move money; they must not create additional revenue.
export function stripeKind(row) {
  const category = row.reporting_category || row.activity_type;
  if (['charge', 'payment'].includes(category)) return 'income';
  if (['refund', 'payment_refund', 'refund_failure', 'payment_failure_refund', 'payment_reversal'].includes(category)) return 'refund';
  if (['fee', 'stripe_fee', 'stripe_fx_fee', 'tax_fee'].includes(category)) return 'fee';
  if (category === 'dispute' || category === 'dispute_reversal') return 'dispute';
  if (['payout', 'payout_reversal', 'payout_cancel', 'payout_failure'].includes(category)) return 'payout';
  if (['transfer','transfer_reversal','connect_collection_transfer','reserved_funds'].includes(category)) return 'transfer';
  return 'adjustment';
}

export function buildFinanceReport({ stripeRows = [], officeRows = [], transactions = [], from, to }) {
  const entries = [];
  for (const row of stripeRows) {
    if (row.currency.toLowerCase() !== 'usd') continue;
    const type = stripeKind(row);
    entries.push({ id: `stripe:${row.id}`, source: 'stripe', date: pacificDate(row.occurred_at), vendor: row.description || 'Stripe activity', description: row.activity_type.replaceAll('_', ' '), type, amount: money(Number(row.amount_cents)), fees: money(Number(row.fee_cents)), net: money(Number(row.net_cents)), category: type === 'fee' ? 'Payment processing fees' : type === 'income' ? 'RV stay collections' : type === 'refund' ? 'Guest refunds' : 'Stripe transfers & adjustments', status: row.balance_status, sourceId: row.source_id, reservationId: row.reservation_id, stripeId: row.id });
  }
  for (const row of officeRows) {
    entries.push({ id: `office:${row.id}`, source: 'office', date: pacificDate(row.recorded_at), vendor: row.guest_name || `Reservation #${row.reservation_id}`, description: row.note || row.payment_source, type: 'income', amount: Math.abs(Number(row.amount)), fees: 0, net: Math.abs(Number(row.amount)), category: 'RV stay collections', status: 'approved', reservationId: row.reservation_id });
  }
  for (const row of transactions) {
    if (row.status !== 'approved' || (row.currency || 'USD').toUpperCase() !== 'USD') continue;
    entries.push({ id: `document:${row.id}`, transactionId: row.id, documentId: row.document_id, source: 'document', date: isoDate(row.transaction_date), vendor: row.vendor || 'Manual entry', description: row.description || '', type: row.transaction_type, amount: Math.abs(Number(row.total || 0)), fees: 0, category: row.category || 'Uncategorized', status: row.status });
  }
  const summary = { stripeGross: 0, officeRevenue: 0, otherRevenue: 0, refunds: 0, fees: 0, expenses: 0, disputes: 0, payouts: 0 };
  const months = new Map();
  const categories = new Map();
  for (const entry of entries) {
    let income = 0, expense = 0;
    const amount = cents(entry.amount), fee = cents(entry.fees);
    if (entry.type === 'income') {
      const target = entry.source === 'stripe' ? 'stripeGross' : entry.source === 'office' ? 'officeRevenue' : 'otherRevenue';
      summary[target] += amount;
      income = amount;
    } else if (entry.type === 'refund') {
      // Positive refund_failure entries reverse an earlier refund.
      if (entry.source === 'stripe') { summary.refunds -= amount; income = amount; }
      else { summary.expenses -= amount; expense = -amount; }
    } else if (entry.type === 'expense') { summary.expenses += amount; expense = amount; }
    else if (entry.type === 'fee') { summary.fees -= amount; expense = -amount; }
    else if (entry.type === 'dispute') { summary.disputes -= amount; income = amount; }
    else if (entry.type === 'payout') { summary.payouts -= amount; }
    summary.fees += fee;
    const baseExpense = expense;
    expense += fee;
    const key = entry.date.slice(0, 7);
    const month = months.get(key) || { month: key, income: 0, expenses: 0 };
    month.income += income; month.expenses += expense; months.set(key, month);
    if (income || baseExpense) {
      const key = `${entry.category}|${income ? 'income' : 'expense'}`;
      const item = categories.get(key) || { category: entry.category, type: income ? 'income' : 'expense', amount: 0 };
      item.amount += income || baseExpense; categories.set(key, item);
    }
    if (fee) {
      const key = 'Payment processing fees|expense';
      const item = categories.get(key) || { category: 'Payment processing fees', type: 'expense', amount: 0 };
      item.amount += fee; categories.set(key, item);
    }
  }
  for (const key of Object.keys(summary)) summary[key] = money(summary[key]);
  summary.grossCollections = money(cents(summary.stripeGross) + cents(summary.officeRevenue) + cents(summary.otherRevenue));
  summary.netRevenue = money(cents(summary.grossCollections) - cents(summary.refunds) - cents(summary.disputes));
  summary.totalExpenses = money(cents(summary.expenses) + cents(summary.fees));
  summary.netIncome = Math.round((summary.netRevenue - summary.totalExpenses) * 100) / 100;
  return { from, to, basis: 'cash', currency: 'USD', summary, entries: entries.sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id)), months: [...months.values()].sort((a, b) => a.month.localeCompare(b.month)).map(row => ({ ...row, income: money(row.income), expenses: money(row.expenses) })), categories: [...categories.values()].map(row => ({ ...row, amount: money(row.amount) })).sort((a, b) => b.amount - a.amount) };
}

export function csvReport(entries) {
  const escape = value => typeof value === 'number' ? String(value) : `"${String(value ?? '').replace(/^\s*[=+@\-]/, "'$&").replaceAll('"', '""')}"`;
  const fields = ['date', 'source', 'vendor', 'description', 'type', 'category', 'amount', 'fees', 'net', 'status', 'reservationId'];
  return [fields.join(','), ...entries.map(entry => fields.map(field => escape(entry[field])).join(','))].join('\r\n');
}

export function registerFinanceRoutes(app, { pool, stripe, notify = () => {} }) {
  const routes = bookkeepingRoutes(app);
  const mode = !String(process.env.STRIPE_SECRET_KEY || '').includes('_test_');
  const errorResponse = (res, error) => res.status(['42P01','42703'].includes(error.code) ? 503 : ['23505','23514','23503'].includes(error.code) ? 409 : error.statusCode || 500).json({ message: ['42P01','42703'].includes(error.code) ? 'Run sql/2026-10-06_bookkeeping_finance.sql on the server database to enable the finance dashboard.' : error.code === '23505' ? 'This record has already been matched or used to pay another bill. Refresh and try again.' : error.message });

  async function report(query) {
    const { from, to } = financePeriod(query);
    const [stripeResult, officeResult, documentResult, tasks, sync, bills] = await Promise.all([
      pool.query(`SELECT * FROM bookkeeping_stripe_activity WHERE livemode = $3 AND occurred_at >= ($1::date::timestamp AT TIME ZONE 'America/Los_Angeles') AND occurred_at < (($2::date + 1)::timestamp AT TIME ZONE 'America/Los_Angeles')`, [from, to, mode]),
      pool.query(`SELECT e.*, concat(c.first_name, ' ', c.last_name) AS guest_name FROM reservation_payment_events e LEFT JOIN reservations r ON r.id=e.reservation_id LEFT JOIN customers c ON c.id=r.customer_id WHERE e.payment_source <> 'stripe' AND e.stripe_payment_record_id IS NULL AND e.recorded_at >= ($1::date::timestamp AT TIME ZONE 'America/Los_Angeles') AND e.recorded_at < (($2::date + 1)::timestamp AT TIME ZONE 'America/Los_Angeles')`, [from, to]),
      pool.query(`SELECT * FROM bookkeeping_transactions WHERE status = 'approved' AND transaction_date BETWEEN $1 AND $2`, [from, to]),
      pool.query(`SELECT (SELECT count(*) FROM bookkeeping_transactions WHERE status='pending') AS review_count, (SELECT count(*) FROM bookkeeping_transactions WHERE status='approved' AND category IS NULL) AS uncategorized_count, (SELECT count(*) FROM bookkeeping_documents WHERE processing_status IN ('uploaded','queued','failed')) AS document_count, (SELECT count(*) FROM bookkeeping_documents WHERE processing_status='processing') AS processing_count, (SELECT count(*) FROM bookkeeping_consolidations) AS consolidated_count`),
      pool.query('SELECT * FROM bookkeeping_finance_sync WHERE id = true AND livemode=$1',[mode]),
      pool.query(`SELECT b.*, d.original_filename AS source_filename FROM bookkeeping_bills b LEFT JOIN bookkeeping_documents d ON d.id=b.document_id WHERE b.status <> 'void' ORDER BY b.status DESC, b.due_date, b.id`)
    ]);
    return { ...buildFinanceReport({ stripeRows: stripeResult.rows, officeRows: officeResult.rows, transactions: documentResult.rows, from, to }), tasks: tasks.rows[0], bills: bills.rows, stripe: { configured: Boolean(stripe), mode: mode ? 'live' : 'test', ...sync.rows[0] }, excludedCurrencyCount: stripeResult.rows.filter(row => row.currency !== 'usd').length + documentResult.rows.filter(row => (row.currency || 'USD').toUpperCase() !== 'USD').length };
  }

  async function syncStripe(query = {}) {
    if (!stripe) throw Object.assign(new Error('Stripe is not configured on the server.'), { statusCode: 503 });
    const { from, to } = financePeriod(query);
    const client = await pool.connect();
    let locked = false;
    try {
      const lock = await client.query('SELECT pg_try_advisory_lock(2147483002) AS locked');
      locked = lock.rows[0].locked;
      if (!locked) throw Object.assign(new Error('Stripe sync is already running. Please wait.'), { statusCode: 409 });
      const records = [];
      for await (const row of stripe.balanceTransactions.list({ limit: 100, created: { gte: Math.floor(Date.parse(from) / 1000), lt: Math.floor(Date.parse(to) / 1000) + 2 * 86400 }, expand: ['data.source'] })) {
        records.push(row);
        if (records.length > 50000) throw new Error('Too many Stripe records for one sync. Choose a smaller date range.');
      }
      const balance = await stripe.balance.retrieve();
      const available = balance.available.filter(row => row.currency === 'usd').reduce((sum,row) => sum+row.amount,0);
      const pending = balance.pending.filter(row => row.currency === 'usd').reduce((sum,row) => sum+row.amount,0);
      await client.query('BEGIN');
      for (const row of records) {
        const source = typeof row.source === 'object' && row.source ? row.source : {};
        const reservation = Number(source.metadata?.reservation_id);
        await client.query(`INSERT INTO bookkeeping_stripe_activity (id,occurred_at,available_at,currency,amount_cents,fee_cents,net_cents,activity_type,reporting_category,description,source_id,payment_intent_id,reservation_id,balance_status,livemode) VALUES ($1,to_timestamp($2),to_timestamp($3),$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) ON CONFLICT (id) DO UPDATE SET balance_status=EXCLUDED.balance_status, available_at=EXCLUDED.available_at, fee_cents=EXCLUDED.fee_cents, net_cents=EXCLUDED.net_cents, synced_at=now()`, [row.id, row.created, row.available_on, row.currency, row.amount, row.fee, row.net, row.type, row.reporting_category || row.type, row.description, typeof row.source === 'string' ? row.source : source.id || null, typeof source.payment_intent === 'string' ? source.payment_intent : null, Number.isSafeInteger(reservation) && reservation > 0 ? reservation : null, row.status, mode]);
      }
      await client.query(`UPDATE bookkeeping_finance_sync SET last_synced_at=now(),period_start=$1,period_end=$2,imported_count=$3,last_error=NULL,available_cents=$4,pending_cents=$5,balance_retrieved_at=now(),livemode=$6 WHERE id=true`, [from, to, records.length,available,pending,mode]);
      await client.query('COMMIT');
      notify({ reason: 'bookkeeping_changed' });
      return { imported: records.length, from, to };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      if (locked) await client.query('UPDATE bookkeeping_finance_sync SET last_error=$1 WHERE id=true', [error.message]).catch(() => {});
      throw error;
    } finally {
      if (locked) await client.query('SELECT pg_advisory_unlock(2147483002)').catch(() => {});
      client.release();
    }
  }

  routes.get('/api/bookkeeping/overview', async (req, res) => { try { res.json(await report(req.query)); } catch (error) { errorResponse(res, error); } });
  routes.get('/api/bookkeeping/reports/profit-loss', async(req,res)=>{
    try {const data=await report(req.query);res.json({...data,reportType:'profit_loss',periodStart:data.from,periodEnd:data.to,revenue:data.summary.netRevenue,expenses:data.summary.totalExpenses,netProfit:data.summary.netIncome,rows:data.categories});} catch(error){errorResponse(res,error);}
  });
  routes.get('/api/bookkeeping/export', async (req, res) => {
    try { const data = await report(req.query); res.setHeader('Content-Disposition', `attachment; filename="riverpark-bookkeeping-${data.from}-${data.to}.csv"`); res.type('text/csv').send(csvReport(data.entries)); } catch (error) { errorResponse(res, error); }
  });
  routes.post('/api/bookkeeping/stripe/sync', async (req, res) => { try { res.json(await syncStripe(req.body)); } catch (error) { errorResponse(res, error); } });

  routes.post('/api/bookkeeping/entries', async (req, res) => {
    const b = req.body || {};
    if (!['income','expense','refund','transfer','adjustment'].includes(b.transaction_type) || !/^\d{4}-\d{2}-\d{2}$/.test(b.transaction_date || '') || !Number.isFinite(Number(b.total)) || cents(b.total) <= 0 || !String(b.vendor || '').trim()) return res.status(400).json({ message: 'Enter a date, vendor, positive amount, and transaction type.' });
    try {
      const result = await pool.query(`INSERT INTO bookkeeping_transactions (uploaded_by_admin_user_id,transaction_date,vendor,description,total,currency,category,payment_account,transaction_type,status,notes,approved_by_admin_user_id,approved_at) VALUES ($1,$2,$3,$4,$5,'USD',$6,$7,$8,'approved',$9,$1,now()) RETURNING *`, [req.adminUser.id,b.transaction_date,b.vendor.trim(),b.description || '',money(cents(b.total)),b.category || null,b.payment_account || null,b.transaction_type,b.notes || 'Manual bookkeeping entry']);
      notify({ reason: 'bookkeeping_changed' }); res.status(201).json({ transaction: result.rows[0] });
    } catch (error) { errorResponse(res, error); }
  });

  routes.post('/api/bookkeeping/consolidate', async (req, res) => {
    const { duplicateId, keeperId, stripeId } = req.body || {};
    if (!duplicateId || Boolean(keeperId) === Boolean(stripeId) || String(duplicateId) === String(keeperId)) return res.status(400).json({ message: 'Choose the duplicate record and the record to keep.' });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const ids = [duplicateId, ...(keeperId ? [keeperId] : [])].sort((a,b) => Number(a)-Number(b));
      const result = await client.query('SELECT * FROM bookkeeping_transactions WHERE id=ANY($1::bigint[]) ORDER BY id FOR UPDATE', [ids]);
      const duplicate = result.rows.find(row => String(row.id) === String(duplicateId));
      const keeper = result.rows.find(row => String(row.id) === String(keeperId));
      if (!duplicate || duplicate.status === 'void' || (keeperId && (!keeper || keeper.status === 'void'))) throw Object.assign(new Error('One of these records has already changed. Refresh and try again.'), { statusCode: 409 });
      if (stripeId) {
        const stripeResult = await client.query('SELECT * FROM bookkeeping_stripe_activity WHERE id=$1 AND livemode=$2', [stripeId,mode]);
        const stripeRow = stripeResult.rows[0];
        if (!stripeRow || !['income','refund','fee','payout'].includes(stripeKind(stripeRow))) throw Object.assign(new Error('This Stripe record cannot be matched.'), { statusCode: 400 });
        const compatible = { income: ['income'], refund: ['refund'], fee: ['expense'], payout: ['transfer'] }[stripeKind(stripeRow)];
        if (!compatible.includes(duplicate.transaction_type) || Math.abs(cents(duplicate.total)) !== Math.abs(Number(stripeRow.amount_cents)) || (duplicate.currency || 'USD').toLowerCase() !== stripeRow.currency) throw Object.assign(new Error('Match records with the same amount, currency and transaction type.'), { statusCode: 400 });
      } else if (Math.abs(cents(duplicate.total)) !== Math.abs(cents(keeper.total)) || (duplicate.currency || 'USD').toUpperCase() !== (keeper.currency || 'USD').toUpperCase() || duplicate.transaction_type !== keeper.transaction_type) throw Object.assign(new Error('Consolidate records with the same amount, currency and type.'), { statusCode: 400 });
      const dependencies = await client.query('SELECT id FROM bookkeeping_consolidations WHERE keeper_transaction_id=$1 UNION ALL SELECT id FROM bookkeeping_bills WHERE paid_transaction_id=$1 AND status=\'paid\'', [duplicateId]);
      if (dependencies.rowCount) throw Object.assign(new Error('This entry supports an existing consolidation or paid bill. Restore or unlink that first.'), {statusCode:409});
      await client.query(`INSERT INTO bookkeeping_consolidations (duplicate_transaction_id,keeper_transaction_id,stripe_activity_id,previous_status,reason,created_by_admin_user_id) VALUES ($1,$2,$3,$4,$5,$6)`, [duplicateId,keeperId || null,stripeId || null,duplicate.status,stripeId ? 'Matched to authoritative Stripe activity' : 'Confirmed duplicate or statement/receipt pair',req.adminUser.id]);
      await client.query("UPDATE bookkeeping_transactions SET status='void' WHERE id=$1", [duplicateId]);
      await client.query('COMMIT'); notify({ reason: 'bookkeeping_changed' }); res.json({ consolidated: true });
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); errorResponse(res, error); } finally { client.release(); }
  });

  routes.get('/api/bookkeeping/consolidations', async (_req,res) => {
    try { const result = await pool.query(`SELECT x.*,t.vendor,t.total,d.original_filename AS source_filename,k.vendor AS keeper_vendor FROM bookkeeping_consolidations x JOIN bookkeeping_transactions t ON t.id=x.duplicate_transaction_id LEFT JOIN bookkeeping_documents d ON d.id=t.document_id LEFT JOIN bookkeeping_transactions k ON k.id=x.keeper_transaction_id ORDER BY x.created_at DESC LIMIT 200`); res.json({ consolidations: result.rows }); } catch (error) { errorResponse(res,error); }
  });
  routes.post('/api/bookkeeping/entries/:id/void', async(req,res) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const row = await client.query('SELECT id FROM bookkeeping_transactions WHERE id=$1 FOR UPDATE',[req.params.id]);
      if(!row.rowCount) throw Object.assign(new Error('Entry not found.'),{statusCode:404});
      const used = await client.query("SELECT id FROM bookkeeping_consolidations WHERE keeper_transaction_id=$1 OR duplicate_transaction_id=$1 UNION ALL SELECT id FROM bookkeeping_bills WHERE paid_transaction_id=$1 AND status='paid'",[req.params.id]);
      if(used.rowCount) throw Object.assign(new Error('Restore the consolidation or unlink the paid bill before excluding this entry.'),{statusCode:409});
      await client.query("UPDATE bookkeeping_transactions SET status='void' WHERE id=$1",[req.params.id]);
      await client.query('COMMIT');notify({reason:'bookkeeping_changed'});res.json({voided:true});
    } catch(error){await client.query('ROLLBACK');errorResponse(res,error);} finally{client.release();}
  });
  routes.delete('/api/bookkeeping/consolidations/:id', async (req,res) => {
    const client = await pool.connect();
    try { await client.query('BEGIN'); const result = await client.query('DELETE FROM bookkeeping_consolidations WHERE id=$1 RETURNING duplicate_transaction_id,previous_status', [req.params.id]); if (!result.rowCount) throw Object.assign(new Error('Consolidation not found.'), { statusCode: 404 }); await client.query('UPDATE bookkeeping_transactions SET status=$2 WHERE id=$1', [result.rows[0].duplicate_transaction_id,result.rows[0].previous_status]); await client.query('COMMIT'); notify({ reason: 'bookkeeping_changed' }); res.json({ restored: true }); } catch (error) { await client.query('ROLLBACK').catch(() => {}); errorResponse(res,error); } finally { client.release(); }
  });

  routes.post('/api/bookkeeping/bills', async (req,res) => {
    const b = req.body || {};
    if (!String(b.vendor || '').trim() || !Number.isFinite(Number(b.amount)) || cents(b.amount) <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(b.due_date || '') || !/^\d{4}-\d{2}-\d{2}$/.test(b.bill_date || '')) return res.status(400).json({ message: 'Enter a vendor, positive amount, bill date and due date.' });
    try { const result = await pool.query(`INSERT INTO bookkeeping_bills (vendor,description,bill_date,due_date,amount,category,document_id,created_by_admin_user_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`, [b.vendor.trim(),b.description || '',b.bill_date,b.due_date,money(cents(b.amount)),b.category || null,b.document_id || null,req.adminUser.id]); notify({ reason: 'bookkeeping_changed' }); res.status(201).json({ bill: result.rows[0] }); } catch (error) { errorResponse(res,error); }
  });
  routes.post('/api/bookkeeping/bills/:id/paid', async (req,res) => {
    const transactionId = Number(req.body?.transactionId);
    if (!transactionId) return res.status(400).json({ message: 'Choose the approved expense that paid this bill.' });
    try { const result = await pool.query(`UPDATE bookkeeping_bills b SET status='paid',paid_transaction_id=t.id,updated_at=now() FROM bookkeeping_transactions t WHERE b.id=$1 AND b.status='unpaid' AND t.id=$2 AND t.status='approved' AND t.transaction_type='expense' AND t.total=b.amount AND COALESCE(t.currency,'USD')='USD' RETURNING b.*`, [req.params.id,transactionId]); if (!result.rowCount) return res.status(409).json({ message: 'Select an approved USD expense for the same amount as the unpaid bill.' }); notify({ reason: 'bookkeeping_changed' }); res.json({ bill: result.rows[0] }); } catch(error) { errorResponse(res,error); }
  });
  routes.patch('/api/bookkeeping/bills/:id', async (req,res) => {
    if (!['unpaid','void'].includes(req.body?.status)) return res.status(400).json({message:'Choose unpaid or void.'});
    try { const result = await pool.query('UPDATE bookkeeping_bills SET status=$2,paid_transaction_id=NULL,updated_at=now() WHERE id=$1 RETURNING *',[req.params.id,req.body.status]); if(!result.rowCount) return res.status(404).json({message:'Bill not found.'}); notify({reason:'bookkeeping_changed'}); res.json({bill:result.rows[0]}); } catch(error){errorResponse(res,error);}
  });

  // The newest 35 days refresh without requiring an open admin browser.
  // Historical periods can be imported explicitly from the dashboard.
  if (stripe) {
    const timer = setInterval(() => {
      syncStripe({ from: pacificDate(Date.now()-35*86400000), to: pacificDate(Date.now()) }).catch(error => { if (error.code !== '42P01' && error.statusCode !== 409) console.warn('Bookkeeping Stripe sync:', error.message); });
    }, 15 * 60 * 1000);
    timer.unref();
  }
}
