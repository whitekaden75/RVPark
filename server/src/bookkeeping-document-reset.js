import { createHash, randomUUID } from 'node:crypto';
import { bookkeepingRoutes } from './bookkeeping-http.js';

const fail = (message, statusCode = 409) => Object.assign(new Error(message), { statusCode });
const validId = value => /^[1-9]\d*$/.test(String(value || ''));

export async function documentResetPreview(client, documentId) {
  const documentResult = await client.query(`SELECT id,original_filename,document_type,processing_status,processed_at,metadata
    FROM bookkeeping_documents WHERE id=$1`, [documentId]);
  if (!documentResult.rowCount) throw fail('Source file not found.', 404);
  const document = documentResult.rows[0];
  // Include every date and previously excluded rows when checking links. A
  // consolidation must not later restore an old entry into a reset import.
  const transactions = await client.query(`SELECT t.*,t.transaction_date::text
    FROM bookkeeping_transactions t WHERE t.document_id=$1 ORDER BY t.id`, [documentId]);
  const ids = transactions.rows.map(row => row.id);
  const matches = await client.query(`SELECT id,duplicate_transaction_id,keeper_transaction_id
    FROM bookkeeping_consolidations WHERE duplicate_transaction_id=ANY($1::bigint[])
      OR keeper_transaction_id=ANY($1::bigint[]) ORDER BY id`, [ids]);
  const bills = await client.query(`SELECT id,vendor,paid_transaction_id FROM bookkeeping_bills
    WHERE status='paid' AND paid_transaction_id=ANY($1::bigint[]) ORDER BY id`, [ids]);
  const entries = transactions.rows.filter(row => row.status !== 'void');
  const totals = new Map();
  for (const entry of entries) {
    const currency = entry.currency || 'USD', type = entry.transaction_type;
    const key = `${currency}:${type}`;
    const total = totals.get(key) || { currency, type, count: 0, amountCents: 0 };
    total.count++; total.amountCents += Math.round(Number(entry.total || 0) * 100); totals.set(key, total);
  }
  const blockers = [];
  if (document.processing_status === 'processing' || document.metadata?.ai_queued) {
    blockers.push('This file is processing or waiting in the AI queue. Finish processing or cancel its queued job first.');
  }
  if (matches.rowCount) blockers.push(`Undo ${matches.rowCount} consolidation/match link(s) involving this file in Reconcile first.`);
  if (bills.rowCount) blockers.push(`Unlink ${bills.rowCount} paid bill(s) first: ${bills.rows.map(row => `#${row.id} ${row.vendor || ''}`).join(', ')}.`);
  if (!entries.length) blockers.push('No active imported entries remain for this file.');
  const snapshot = createHash('sha256').update(JSON.stringify({ document, transactions: transactions.rows, matches: matches.rows, bills: bills.rows })).digest('hex');
  return { document, entries, count: entries.length, totals: [...totals.values()].map(row => ({ ...row, amount: row.amountCents / 100 })), blockers, canReset: !blockers.length, snapshot };
}

export function registerDocumentEntryResetRoutes(app, { pool, notify = () => {} }) {
  const routes = bookkeepingRoutes(app);
  routes.get('/api/bookkeeping/document-entry-resets/sources', async (_req, res) => {
    const result = await pool.query(`SELECT d.id,d.original_filename,d.document_type,d.processing_status,
      count(t.id)::integer AS entry_count
      FROM bookkeeping_documents d JOIN bookkeeping_transactions t ON t.document_id=d.id AND t.status<>'void'
      GROUP BY d.id ORDER BY d.uploaded_at DESC,d.id DESC`);
    res.json({ documents: result.rows });
  });
  routes.get('/api/bookkeeping/documents/:id/reset-preview', async (req, res) => {
    if (!validId(req.params.id)) return res.status(400).json({ message: 'Choose a source file.' });
    const client = await pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const preview = await documentResetPreview(client, req.params.id);
      await client.query('COMMIT'); res.json(preview);
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    finally { client.release(); }
  });
  routes.post('/api/bookkeeping/documents/:id/reset-entries', async (req, res) => {
    if (!validId(req.params.id) || String(req.body?.confirmDocumentId) !== String(req.params.id) || !/^[a-f0-9]{64}$/.test(req.body?.snapshot || '')) {
      return res.status(400).json({ message: 'Review and confirm the selected file before resetting its entries.' });
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const locked = await client.query('SELECT pg_try_advisory_xact_lock(2147483001) AS locked');
      if (!locked.rows[0]?.locked) throw fail('Another document is being processed. Wait for it to finish before resetting this file.');
      await client.query("SET LOCAL lock_timeout = '5s'");
      await client.query('LOCK TABLE bookkeeping_transactions, bookkeeping_documents, bookkeeping_consolidations, bookkeeping_bills IN SHARE ROW EXCLUSIVE MODE');
      const preview = await documentResetPreview(client, req.params.id);
      if (preview.snapshot !== req.body.snapshot) throw fail('This file or its transactions changed. Refresh the review before resetting.');
      if (!preview.canReset) throw fail(preview.blockers.join(' '));
      const reset = { id: randomUUID(), resetAt: new Date().toISOString(), adminUserId: req.adminUser.id,
        entries: preview.entries.map(row => ({ id: row.id, previousStatus: row.status })) };
      const removed = await client.query(`UPDATE bookkeeping_transactions SET status='void'
        WHERE document_id=$1 AND status<>'void' RETURNING id`, [req.params.id]);
      if (removed.rowCount !== preview.count) throw fail('The imported entries changed. Refresh the review and try again.');
      await client.query(`UPDATE bookkeeping_documents SET processing_status='queued',processed_at=NULL,error_message=NULL,
        metadata=COALESCE(metadata,'{}'::jsonb) || jsonb_build_object('ai_queued',false,
          'transaction_reset_history',COALESCE(metadata->'transaction_reset_history','[]'::jsonb) || $2::jsonb)
        WHERE id=$1`, [req.params.id, JSON.stringify([reset])]);
      await client.query('COMMIT'); notify({ reason: 'bookkeeping_changed' });
      res.json({ removedCount: removed.rowCount, documentId: preview.document.id, filename: preview.document.original_filename, readyToQueue: true });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      if (['55P03', '40P01'].includes(error.code)) throw fail('Bookkeeping is being updated. Wait a moment and refresh the review.');
      throw error;
    } finally { client.release(); }
  });
}
