import { DeleteObjectCommand } from '@aws-sdk/client-s3';

const fail = (message, statusCode = 409) => Object.assign(new Error(message), { statusCode });

export async function deleteBookkeepingDocument({ pool, storage, bucket, storageConfigError, documentId, confirmedExcludedCount = 0 }) {
  if (!/^[1-9]\d*$/.test(String(documentId || ''))) throw fail('Choose a valid document.', 400);
  if (!storage || !bucket) throw fail(storageConfigError || 'Document storage is not configured.', 503);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '5s'");
    // Queue/processing claims and new foreign-key links must wait until deletion finishes.
    const result = await client.query('SELECT id,storage_key,processing_status,metadata FROM bookkeeping_documents WHERE id=$1 FOR UPDATE', [documentId]);
    if (!result.rowCount) throw fail('Document not found.', 404);
    const document = result.rows[0];
    if (document.metadata?.ai_queued || !['uploaded', 'queued', 'failed', 'rejected', 'needs_review', 'approved'].includes(document.processing_status)) {
      throw fail('This file is queued or processing. Cancel its waiting AI job or wait for processing to finish before deleting it.');
    }
    // Lock every entry so approval, restoration and new bill/match links cannot race deletion.
    const transactions = await client.query('SELECT id,status FROM bookkeeping_transactions WHERE document_id=$1 ORDER BY id FOR UPDATE', [documentId]);
    if (transactions.rows.some(row => row.status !== 'void')) throw fail('This file still has active transactions. Reset or exclude all its entries before deleting the file.');
    if (!Number.isSafeInteger(confirmedExcludedCount) || confirmedExcludedCount < 0 || confirmedExcludedCount !== transactions.rowCount) throw fail('The excluded-entry count changed. Refresh Documents and review the deletion again.');
    const ids = transactions.rows.map(row => row.id);
    const bills = await client.query('SELECT id FROM bookkeeping_bills WHERE document_id=$1 OR paid_transaction_id=ANY($2::bigint[]) LIMIT 1', [documentId, ids]);
    if (bills.rowCount) throw fail('This file or an excluded entry is linked to a bill. Remove its bill links before deleting the file.');
    const matches = await client.query(`SELECT id FROM bookkeeping_consolidations
      WHERE duplicate_transaction_id=ANY($1::bigint[]) OR keeper_transaction_id=ANY($1::bigint[]) LIMIT 1`, [ids]);
    if (matches.rowCount) throw fail('An excluded entry is linked to a consolidation or match. Undo those links in Reconcile before deleting the file.');
    if (ids.length) {
      await client.query('DELETE FROM bookkeeping_line_items WHERE transaction_id=ANY($1::bigint[])', [ids]);
      const excluded = await client.query("DELETE FROM bookkeeping_transactions WHERE document_id=$1 AND status='void' RETURNING id", [documentId]);
      if (excluded.rowCount !== transactions.rowCount) throw fail('This file’s entries changed. Refresh Documents and review the deletion again.');
    }
    await client.query('DELETE FROM bookkeeping_extractions WHERE document_id=$1', [documentId]);
    const removed = await client.query('DELETE FROM bookkeeping_documents WHERE id=$1 RETURNING id', [documentId]);
    if (!removed.rowCount) throw fail('This file changed before it could be deleted. Refresh Documents and try again.');
    // Check all database constraints first; a storage failure rolls back the file and its history.
    try { await storage.send(new DeleteObjectCommand({ Bucket: bucket, Key: document.storage_key })); }
    catch { throw fail('The file could not be removed from storage. It remains in Documents; try deleting it again.', 502); }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    if (['55P03', '40P01'].includes(error.code)) throw fail('This file is being updated. Refresh Documents and try again.');
    if (error.code === '23503') throw fail('This file has linked bookkeeping records and cannot be deleted.');
    throw error;
  } finally { client.release(); }
}
