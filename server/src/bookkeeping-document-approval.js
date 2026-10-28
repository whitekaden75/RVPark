import { createHash } from 'node:crypto';

const types = ['all', 'income', 'expense', 'refund', 'transfer', 'adjustment'];
const fail = (message, statusCode = 409) => Object.assign(new Error(message), { statusCode });
const pendingForType = (rows, type) => rows.filter(row => row.status === 'pending' && (type === 'all' || (row.transaction_type || 'adjustment') === type));

function approvalPreview(document, transactions, type) {
  const pending = pendingForType(transactions, type).sort((a, b) => BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0);
  const snapshot = createHash('sha256').update(JSON.stringify({
    documentId: String(document.id), filename: document.original_filename,
    processingStatus: document.processing_status, aiQueued: Boolean(document.metadata?.ai_queued), type,
    transactions: pending.map(row => Object.fromEntries(Object.entries(row).sort(([a], [b]) => a.localeCompare(b))))
  })).digest('hex');
  return { count: pending.length, snapshot };
}

export function documentApprovalPreviews(document, transactions) {
  return Object.fromEntries(types.map(type => [type, approvalPreview(document, transactions, type)]));
}

function validForApproval(row) {
  const date = row.transaction_date;
  return /^\d{4}-\d{2}-\d{2}$/.test(date || '') && Number.isFinite(Date.parse(date)) && new Date(date).toISOString().slice(0, 10) === date &&
    Boolean(row.vendor?.trim()) && row.total != null && Number.isFinite(Number(row.total)) && Number(row.total) >= 0 &&
    /^[A-Z]{3}$/.test(row.currency || 'USD') && types.slice(1).includes(row.transaction_type || 'adjustment');
}

export async function approveDocumentTransactions({ pool, documentId, transactionType, snapshot, adminUserId }) {
  if (!/^[1-9]\d*$/.test(String(documentId || '')) || !types.includes(transactionType) || !/^[a-f0-9]{64}$/.test(snapshot || '')) {
    throw fail('Choose a document and review its current transaction filter before approving.', 400);
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '5s'");
    const documentResult = await client.query(`SELECT id,original_filename,processing_status,metadata
      FROM bookkeeping_documents WHERE id=$1 FOR UPDATE`, [documentId]);
    if (!documentResult.rowCount) throw fail('Document not found.', 404);
    const document = documentResult.rows[0];
    if (document.processing_status === 'processing' || document.metadata?.ai_queued) throw fail('Wait for this file to finish processing before approving its transactions.');
    // Lock the whole file so edits cannot move entries into or out of the selected type mid-approval.
    const transactions = await client.query(`SELECT t.*,t.transaction_date::text FROM bookkeeping_transactions t
      WHERE t.document_id=$1 ORDER BY t.id FOR UPDATE`, [documentId]);
    const preview = approvalPreview(document, transactions.rows, transactionType);
    if (preview.snapshot !== snapshot) throw fail('These pending transactions changed after your review. Refresh the list and review approval again.');
    const pending = pendingForType(transactions.rows, transactionType);
    if (!pending.length) throw fail('No pending transactions remain in this filter. Refresh the list.');
    const invalid = pending.filter(row => !validForApproval(row));
    if (invalid.length) throw fail(`Review incomplete entries ${invalid.slice(0, 10).map(row => `#${row.id}`).join(', ')}${invalid.length > 10 ? ' and others' : ''}. Each needs a valid date, vendor, nonnegative amount, currency and type. No transactions were approved.`, 422);
    const updated = await client.query(`UPDATE bookkeeping_transactions SET status='approved',
      approved_by_admin_user_id=$2,approved_at=NOW()
      WHERE document_id=$1 AND status='pending' AND id=ANY($3::bigint[])
      AND ($4::text='all' OR COALESCE(transaction_type,'adjustment')=$4) RETURNING id`,
    [documentId, adminUserId, pending.map(row => row.id), transactionType]);
    if (updated.rowCount !== pending.length) throw fail('The transaction list changed. Refresh and review approval again.');
    await client.query(`UPDATE bookkeeping_documents SET processing_status=CASE WHEN EXISTS
      (SELECT 1 FROM bookkeeping_transactions WHERE document_id=$1 AND status='pending')
      THEN 'needs_review' ELSE 'approved' END WHERE id=$1`, [documentId]);
    await client.query('COMMIT');
    return { approvedCount: updated.rowCount, documentId: document.id, transactionType };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    if (['55P03', '40P01'].includes(error.code)) throw fail('This file is being updated. Refresh and review approval again.');
    throw error;
  } finally { client.release(); }
}
