import { DeleteObjectCommand } from '@aws-sdk/client-s3';

const fail = (message, statusCode = 409) => Object.assign(new Error(message), { statusCode });

export async function deleteUnprocessedDocument({ pool, storage, bucket, storageConfigError, documentId }) {
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
    if (document.metadata?.ai_queued || !['uploaded', 'queued', 'failed'].includes(document.processing_status)) {
      throw fail('This file is queued, processing, or has already been processed. Cancel its waiting AI job before deleting an unused upload.');
    }
    const transactions = await client.query('SELECT id FROM bookkeeping_transactions WHERE document_id=$1 LIMIT 1', [documentId]);
    if (transactions.rowCount || document.metadata?.transaction_reset_history?.length) throw fail('This file has transaction history, including any excluded entries. Keep the original and use Reset entries to start over.');
    const extractions = await client.query('SELECT id FROM bookkeeping_extractions WHERE document_id=$1 LIMIT 1', [documentId]);
    if (extractions.rowCount) throw fail('This file has extraction history. Keep the original for your bookkeeping records.');
    const bills = await client.query('SELECT id FROM bookkeeping_bills WHERE document_id=$1 LIMIT 1', [documentId]);
    if (bills.rowCount) throw fail('This file is linked to a bill. Keep the original for your bookkeeping records.');
    // Storage deletion is idempotent. Keep the library record on storage failure so it can be retried.
    try { await storage.send(new DeleteObjectCommand({ Bucket: bucket, Key: document.storage_key })); }
    catch { throw fail('The file could not be removed from storage. It remains in Documents; try deleting it again.', 502); }
    const removed = await client.query('DELETE FROM bookkeeping_documents WHERE id=$1 RETURNING id', [documentId]);
    if (!removed.rowCount) throw fail('This file changed before it could be deleted. Refresh Documents and try again.');
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    if (['55P03', '40P01'].includes(error.code)) throw fail('This file is being updated. Refresh Documents and try again.');
    if (error.code === '23503') throw fail('This file has linked bookkeeping records and cannot be deleted.');
    throw error;
  } finally { client.release(); }
}
