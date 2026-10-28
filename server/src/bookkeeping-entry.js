const fail = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });

export async function createBookkeepingEntry({ pool, body = {}, adminUserId }) {
  const date = body.transaction_date, total = Number(body.total);
  const vendor = String(body.vendor || '').trim();
  if (!['income','expense','refund','transfer','adjustment'].includes(body.transaction_type) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(date || '') || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0,10) !== date ||
      !Number.isFinite(total) || Math.round(total * 100) <= 0 || !vendor) {
    throw fail('Enter a valid date, vendor, positive amount, and transaction type.');
  }
  const documentId = body.document_id === '' || body.document_id == null ? null : String(body.document_id);
  if (documentId != null && (!/^[1-9]\d*$/.test(documentId) || BigInt(documentId) > 9223372036854775807n)) throw fail('Choose a valid bank or credit-card statement.');
  const account = String(body.payment_account || '').trim();
  if (account.length > 200) throw fail('Keep the bank or credit-card account label under 200 characters.');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '5s'");
    if (documentId) {
      const result = await client.query('SELECT id,document_type,processing_status,metadata FROM bookkeeping_documents WHERE id=$1 FOR UPDATE', [documentId]);
      const document = result.rows[0];
      if (!document) throw fail('Statement not found. Refresh and select it again.', 404);
      if (!['bank_statement','credit_card_statement'].includes(document.document_type)) throw fail('Select a bank or credit-card statement.');
      if (!['needs_review','approved'].includes(document.processing_status) || document.metadata?.ai_queued) throw fail('Finish AI processing for this statement before adding a transaction.', 409);
    }
    // A manually supplied statement entry must be reviewed with the rest of that file.
    const status = documentId ? 'pending' : 'approved';
    const result = await client.query(`INSERT INTO bookkeeping_transactions
      (uploaded_by_admin_user_id,transaction_date,vendor,description,total,currency,category,payment_account,transaction_type,status,notes,document_id,approved_by_admin_user_id,approved_at)
      VALUES ($1,$2,$3,$4,$5,'USD',$6,$7,$8,$9,$10,$11,CASE WHEN $9='approved' THEN $1 ELSE NULL END,CASE WHEN $9='approved' THEN now() ELSE NULL END) RETURNING *`,
    [adminUserId,date,vendor,body.description || '',Math.round(total * 100) / 100,body.category || null,account || null,body.transaction_type,status,body.notes || (documentId ? 'Manually added to statement' : 'Manual bookkeeping entry'),documentId]);
    if (documentId) await client.query("UPDATE bookkeeping_documents SET processing_status='needs_review' WHERE id=$1", [documentId]);
    await client.query('COMMIT');
    return result.rows[0];
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    if (['55P03','40P01'].includes(error.code)) throw fail('This statement is being updated. Refresh and try again.', 409);
    throw error;
  } finally { client.release(); }
}
