import { createHash } from "node:crypto";
import path from "node:path";
import { CopyObjectCommand, DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import multer from "multer";
import OpenAI from "openai";
import { extractBookkeepingDocument } from "./bookkeeping-extraction.js";
import { loadBookkeepingAudit, statementAudit } from "./bookkeeping-audit.js";
import { bookkeepingRoutes } from "./bookkeeping-http.js";
import { bookkeepingStorageConfig, bookkeepingStorageErrorMessage, storageCopySource } from "./bookkeeping-storage.js";
import { registerDocumentEntryResetRoutes } from "./bookkeeping-document-reset.js";
import { deleteBookkeepingDocument } from "./bookkeeping-document-deletion.js";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (_req, file, callback) => {
    const allowed = new Set(["application/pdf", "image/jpeg", "image/png", "image/webp", "text/csv", "application/msword", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "application/vnd.ms-excel", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"]);
    callback(null, allowed.has(file.mimetype));
  }
});

function normalizeTransactionType(value) {
  const normalized = String(value || "").trim().toLowerCase().replace(/[ -]+/g, "_");
  const aliases = {
    purchase: "expense", purchases: "expense", debit: "expense", charge: "expense", payment: "expense",
    sale: "income", sales: "income", credit: "income", deposit: "income", revenue: "income",
    reimbursement: "refund", returned: "refund", transfer_in: "transfer", transfer_out: "transfer"
  };
  return aliases[normalized] || ["income", "expense", "transfer", "refund", "adjustment"].includes(normalized)
    ? (aliases[normalized] || normalized)
    : "expense";
}

function safeFilenamePart(value, fallback) {
  const part = String(value || fallback).trim().replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return part || fallback;
}

async function extractDocument(file, note = "", categories = []) {
  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not configured.");
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return extractBookkeepingDocument(client, file, {
    model: process.env.OPENAI_BOOKKEEPING_MODEL || "gpt-5",
    note, categories,
  });
}

export function registerBookkeepingRoutes(app, { pool, notify = () => {} }) {
  const routes = bookkeepingRoutes(app);
  registerDocumentEntryResetRoutes(app, { pool, notify });
  const { bucket, options: storageOptions, error: storageConfigError } = bookkeepingStorageConfig();
  const storage = storageOptions ? new S3Client(storageOptions) : null;

  routes.get("/api/bookkeeping/categories", async (_req, res) => {
    const result = await pool.query("SELECT id, name, category_type FROM bookkeeping_categories WHERE is_active = TRUE ORDER BY category_type, name");
    return res.json({ categories: result.rows });
  });

  routes.post("/api/bookkeeping/categories", async (req, res) => {
    const name = String(req.body?.name || "").trim().slice(0, 100);
    const categoryType = ["income", "expense", "other"].includes(req.body?.category_type) ? req.body.category_type : "expense";
    if (!name) return res.status(400).json({ message: "Category name is required." });
    try {
      const result = await pool.query("INSERT INTO bookkeeping_categories (name, category_type) VALUES ($1, $2) RETURNING id, name, category_type", [name, categoryType]);
      notify({ reason: "bookkeeping_changed" });
      return res.status(201).json({ category: result.rows[0] });
    } catch (error) {
      if (error.code === "23505") return res.status(409).json({ message: "That category already exists." });
      throw error;
    }
  });

  routes.post("/api/bookkeeping/documents", upload.single("file"), async (req, res) => {
    if (!req.file) return res.status(400).json({ message: "Upload a PDF, CSV, JPG, PNG, or WEBP file." });
    if (!storage || !bucket) return res.status(503).json({ message: storageConfigError });
    const hash = createHash("sha256").update(req.file.buffer).digest("hex");
    const existing = await pool.query("SELECT id, processing_status FROM bookkeeping_documents WHERE sha256_hash = $1", [hash]);
    if (existing.rowCount) return res.status(409).json({ message: "This document was already uploaded.", document: existing.rows[0] });
    const idResult = await pool.query("SELECT nextval('bookkeeping_documents_id_seq') AS id");
    const id = idResult.rows[0].id;
    const key = `bookkeeping/${new Date().toISOString().slice(0, 7)}/${id}-${path.basename(req.file.originalname).replace(/[^a-zA-Z0-9._-]/g, "_")}`;
    await storage.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: req.file.buffer, ContentType: req.file.mimetype }));
    const note = String(req.body?.note || "").trim().slice(0, 4000);
    const result = await pool.query(`INSERT INTO bookkeeping_documents (id, uploaded_by_admin_user_id, original_filename, mime_type, file_size_bytes, storage_key, sha256_hash, document_type, processing_status, metadata) VALUES ($1,$2,$3,$4,$5,$6,$7,'other','queued',$8) RETURNING *`, [id, req.adminUser.id, req.file.originalname, req.file.mimetype, req.file.size, key, hash, JSON.stringify({ note })]);
    notify({ reason: "bookkeeping_changed" });
    return res.status(201).json({ document: result.rows[0] });
  });

  routes.get("/api/bookkeeping/documents", async (_req, res) => {
    const result = await pool.query(`SELECT d.*,COALESCE(counts.transaction_count,0) AS transaction_count,
      COALESCE(counts.history_count,0)>0 AS has_transaction_history,
      COALESCE(counts.excluded_count,0) AS excluded_transaction_count,
      EXISTS(SELECT 1 FROM bookkeeping_extractions e WHERE e.document_id=d.id) AS has_extraction_history,
      EXISTS(SELECT 1 FROM bookkeeping_bills b WHERE b.document_id=d.id OR b.paid_transaction_id IN
        (SELECT t.id FROM bookkeeping_transactions t WHERE t.document_id=d.id)) AS has_bill_links,
      EXISTS(SELECT 1 FROM bookkeeping_consolidations c WHERE c.duplicate_transaction_id IN
        (SELECT t.id FROM bookkeeping_transactions t WHERE t.document_id=d.id) OR c.keeper_transaction_id IN
        (SELECT t.id FROM bookkeeping_transactions t WHERE t.document_id=d.id)) AS has_consolidation_links
      FROM (SELECT * FROM bookkeeping_documents ORDER BY uploaded_at DESC,id DESC LIMIT 200) d
      LEFT JOIN (SELECT t.document_id,count(*) FILTER (WHERE t.status<>'void')::integer AS transaction_count,
        count(*) FILTER (WHERE t.status='void')::integer AS excluded_count,
        count(*)::integer AS history_count FROM bookkeeping_transactions t GROUP BY t.document_id) counts ON counts.document_id=d.id
      ORDER BY d.uploaded_at DESC,d.id DESC`);
    return res.json({ documents: result.rows });
  });

  routes.get('/api/bookkeeping/documents/:id/transactions', async (req, res) => {
    if (!/^[1-9]\d*$/.test(String(req.params.id || ''))) return res.status(400).json({ message: 'Choose a valid document.' });
    const client = await pool.connect();
    try {
      // Read the processing state and every saved entry from the same snapshot.
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const document = await client.query(`SELECT id,original_filename,document_type,processing_status,processed_at,error_message,metadata
        FROM bookkeeping_documents WHERE id=$1`, [req.params.id]);
      if (!document.rowCount) {
        await client.query('ROLLBACK');
        return res.status(404).json({ message: 'Document not found.' });
      }
      const transactions = await client.query(`SELECT t.*,t.transaction_date::text FROM bookkeeping_transactions t
        WHERE t.document_id=$1 ORDER BY t.transaction_date ASC NULLS LAST,t.id ASC`, [req.params.id]);
      await client.query('COMMIT');
      return res.json({ document: document.rows[0], transactions: transactions.rows });
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    finally { client.release(); }
  });

  routes.get("/api/bookkeeping/documents/:id/download", async (req, res) => {
    if (!storage || !bucket) return res.status(503).json({ message: storageConfigError });
    const result = await pool.query("SELECT storage_key, original_filename, mime_type FROM bookkeeping_documents WHERE id = $1", [req.params.id]);
    if (!result.rowCount) return res.status(404).json({ message: "Document not found." });
    const url = await getSignedUrl(storage, new GetObjectCommand({ Bucket: bucket, Key: result.rows[0].storage_key, ResponseContentDisposition: `inline; filename=\"${result.rows[0].original_filename.replaceAll('"', '')}\"` }), { expiresIn: 900 });
    return res.json({ url, mimeType: result.rows[0].mime_type, filename: result.rows[0].original_filename });
  });

  routes.delete("/api/bookkeeping/documents/:id", async (req, res) => {
    await deleteBookkeepingDocument({ pool, storage, bucket, storageConfigError, documentId: req.params.id, confirmedExcludedCount: req.body?.confirmedExcludedCount });
    notify({ reason: "bookkeeping_changed" });
    return res.status(204).end();
  });

  async function processDocument(req, res) {
    if (!storage || !bucket) return res.status(503).json({ message: storageConfigError });
    const client = await pool.connect();
    let claimed = false;
    let processingLockHeld = false;
    let processingStage = 'claim';
    try {
      const lockResult = await client.query("SELECT pg_try_advisory_lock(2147483001) AS locked");
      if (!lockResult.rows[0].locked) {
        return res.status(409).json({ code: "BOOKKEEPING_BUSY", message: "Another bookkeeping document is being processed. This document can be retried shortly." });
      }
      processingLockHeld = true;
      const documentResult = await client.query("SELECT * FROM bookkeeping_documents WHERE id = $1", [req.params.id]);
      if (!documentResult.rowCount) return res.status(404).json({ message: "Document not found." });
      const document = documentResult.rows[0];
      // A crashed worker releases its advisory lock. Only its queued job may be recovered.
      if (req.fromQueue && document.processing_status === 'processing' && document.metadata?.ai_queued) {
        await client.query("UPDATE bookkeeping_documents SET processing_status='queued' WHERE id=$1", [document.id]);
      }
      const claim = await client.query(`UPDATE bookkeeping_documents SET processing_status='processing', error_message=NULL WHERE id=$1 AND processing_status IN ('uploaded','queued','failed') ${req.fromQueue ? "AND metadata->>'ai_queued'='true'" : ''} RETURNING id`, [document.id]);
      if (!claim.rowCount) return res.status(409).json({ message: "This document is already processing or has been processed." });
      claimed = true;
      notify({ reason: "bookkeeping_changed" });
      const adminNote = String(req.body?.note || document.metadata?.note || "").trim().slice(0, 4000);
      if (adminNote && JSON.stringify(document.metadata?.note || "") !== JSON.stringify(adminNote)) {
        await client.query("UPDATE bookkeeping_documents SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{note}', to_jsonb($2::text)) WHERE id = $1", [document.id, adminNote]);
        document.metadata = { ...(document.metadata || {}), note: adminNote };
      }
      processingStage = 'download';
      const storageObject = await storage.send(new GetObjectCommand({ Bucket: bucket, Key: document.storage_key }));
      const chunks = [];
      for await (const chunk of storageObject.Body) chunks.push(chunk);
      processingStage = 'extraction';
      const categories = await client.query("SELECT name, category_type FROM bookkeeping_categories WHERE is_active = TRUE ORDER BY category_type, name");
      const extracted = await extractDocument({ buffer: Buffer.concat(chunks), mimetype: document.mime_type, originalname: document.original_filename }, document.metadata?.note || "", categories.rows);
      const firstTransaction = Array.isArray(extracted.transactions) ? extracted.transactions[0] : null;
      const extension = document.original_filename.includes(".") ? document.original_filename.slice(document.original_filename.lastIndexOf(".")) : "";
      const renamedFilename = `${safeFilenamePart(extracted.documentType, "document")}-${safeFilenamePart(firstTransaction?.vendor, "unknown-vendor")}-${safeFilenamePart(firstTransaction?.transactionDate, new Date().toISOString().slice(0, 10))}${extension}`;
      const renamedKey = `${document.storage_key.slice(0, document.storage_key.lastIndexOf("/") + 1)}${document.id}-${renamedFilename}`;
      if (renamedKey !== document.storage_key) {
        processingStage = 'copy';
        await storage.send(new CopyObjectCommand({ Bucket: bucket, CopySource: storageCopySource(bucket, document.storage_key), Key: renamedKey, ContentType: document.mime_type, MetadataDirective: "REPLACE" }));
      }
      processingStage = 'save';
      await client.query("BEGIN");
      await client.query("INSERT INTO bookkeeping_extractions (document_id, model, extracted_json, confidence) VALUES ($1,$2,$3,$4)", [document.id, process.env.OPENAI_BOOKKEEPING_MODEL || "gpt-5", extracted, extracted.confidence || null]);
      for (const item of Array.isArray(extracted.transactions) ? extracted.transactions : []) {
        const tx = await client.query(`INSERT INTO bookkeeping_transactions (document_id, uploaded_by_admin_user_id, transaction_date, vendor, description, subtotal, tax, total, currency, category, payment_account, transaction_type, ai_confidence) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`, [document.id, req.adminUser.id, item.transactionDate || null, item.vendor || null, item.description || null, item.subtotal ?? null, item.tax ?? null, item.total ?? 0, item.currency || "USD", item.category || null, item.paymentAccount || null, normalizeTransactionType(item.transactionType), item.confidence || extracted.confidence || null]);
        for (const line of Array.isArray(item.lineItems) ? item.lineItems : []) await client.query("INSERT INTO bookkeeping_line_items (transaction_id, description, quantity, unit_price, amount, category) VALUES ($1,$2,$3,$4,$5,$6)", [tx.rows[0].id, line.description || "Item", line.quantity ?? null, line.unitPrice ?? null, line.amount ?? 0, line.category || null]);
      }
      await client.query("UPDATE bookkeeping_documents SET original_filename=$2, storage_key=$3, document_type=$4, processing_status='needs_review', processed_at=NOW(), error_message=NULL,metadata=metadata || '{\"ai_queued\":false}'::jsonb WHERE id=$1", [document.id, renamedFilename, renamedKey, extracted.documentType || "other"]);
      await client.query("COMMIT");
      if(renamedKey !== document.storage_key) await storage.send(new DeleteObjectCommand({Bucket:bucket,Key:document.storage_key})).catch(() => {});
      notify({ reason: "bookkeeping_changed" });
      return res.json({ extracted });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      const message = ['download', 'copy'].includes(processingStage)
        ? bookkeepingStorageErrorMessage(error, processingStage) : error.message;
      if (['download', 'copy'].includes(processingStage)) {
        console.warn('Bookkeeping storage request failed', {
          documentId: req.params.id, operation: processingStage, code: error.name || error.code,
          statusCode: error.$metadata?.httpStatusCode, requestId: error.$metadata?.requestId
        });
      }
      if (claimed) {
        await pool.query("UPDATE bookkeeping_documents SET processing_status='failed', error_message=$2,metadata=COALESCE(metadata,'{}'::jsonb) || '{\"ai_queued\":false}'::jsonb WHERE id=$1", [req.params.id, message]);
        notify({ reason: "bookkeeping_changed" });
      }
      return res.status(500).json({ message });
    } finally {
      if (processingLockHeld) await client.query("SELECT pg_advisory_unlock(2147483001)").catch(() => {});
      client.release();
    }
  }
  routes.post("/api/bookkeeping/documents/:id/process", processDocument);

  routes.post('/api/bookkeeping/queue', async (req,res) => {
    const ids = (Array.isArray(req.body?.ids) ? req.body.ids : []).filter(id => /^\d+$/.test(String(id))).slice(0,200);
    if (!ids.length) return res.status(400).json({message:'Choose at least one document.'});
    const note = typeof req.body.note === 'string' ? req.body.note.trim().slice(0,4000) : null;
    const result = await pool.query(`UPDATE bookkeeping_documents SET processing_status='queued',error_message=NULL,metadata=COALESCE(metadata,'{}'::jsonb) || jsonb_build_object('ai_queued',true,'ai_queued_by',$2::bigint,'ai_queued_at',now()) || CASE WHEN $3::text IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('note',$3::text) END WHERE id=ANY($1::bigint[]) AND processing_status IN ('uploaded','queued','failed') RETURNING id`,[ids,req.adminUser.id,note]);
    notify({reason:'bookkeeping_changed'});
    res.json({queued:result.rowCount});
    runQueue().catch(error => console.warn('Bookkeeping queue:',error.message));
  });
  let queueRunning = false;
  routes.delete('/api/bookkeeping/queue', async(req,res)=>{
    const ids=(Array.isArray(req.body?.ids)?req.body.ids:[]).filter(id=>/^\d+$/.test(String(id))).slice(0,200);
    if(!ids.length)return res.status(400).json({message:'Choose queued documents to cancel.'});
    const result=await pool.query("UPDATE bookkeeping_documents SET metadata=metadata || '{\"ai_queued\":false}'::jsonb WHERE id=ANY($1::bigint[]) AND processing_status='queued' RETURNING id",[ids]);
    notify({reason:'bookkeeping_changed'});res.json({cancelled:result.rowCount});
  });
  async function runQueue() {
    if(queueRunning || !storage || !bucket) return;
    queueRunning = true;
    try {
      while(true) {
        const result = await pool.query("SELECT id,uploaded_by_admin_user_id,metadata FROM bookkeeping_documents WHERE metadata->>'ai_queued'='true' AND processing_status IN ('queued','processing') ORDER BY metadata->>'ai_queued_at',id LIMIT 1");
        const doc = result.rows[0];
        if(!doc) break;
        let status = 200;
        const response = {status(value){status=value;return this;},json(){return this;}};
        await processDocument({params:{id:doc.id},body:{},fromQueue:true,adminUser:{id:doc.metadata.ai_queued_by || doc.uploaded_by_admin_user_id}},response);
        if(status === 409 || status === 503) break;
      }
    } finally {queueRunning=false;}
  }
  if(storage && bucket) {
    const timer = setInterval(() => runQueue().catch(error => {if(error.code!=='42P01') console.warn('Bookkeeping queue:',error.message);}),10000);
    timer.unref();
  }

  routes.get("/api/bookkeeping/transactions", async (req, res) => {
    const requestedStatus = String(req.query.status || "pending");
    const statusClause = requestedStatus === "all" ? "t.status <> 'void'" : "t.status = $1";
    const params = requestedStatus === "all" ? [] : [requestedStatus];
    const requestedLimit = Number(req.query.limit);
    const limit = Number.isInteger(requestedLimit) ? Math.max(1,Math.min(5000,requestedLimit)) : 500;
    const order = requestedStatus === 'pending' ? 't.id DESC' : 't.transaction_date DESC NULLS LAST, t.id DESC';
    const result = await pool.query(`SELECT t.*, d.original_filename AS source_filename, d.document_type AS source_document_type FROM bookkeeping_transactions t LEFT JOIN bookkeeping_documents d ON d.id = t.document_id WHERE ${statusClause} ORDER BY ${order} LIMIT ${limit}`, params);
    return res.json({ transactions: result.rows });
  });
  routes.get('/api/bookkeeping/transactions/:id', async(req,res) => {
    const result = await pool.query('SELECT t.*,d.original_filename AS source_filename,d.document_type AS source_document_type FROM bookkeeping_transactions t LEFT JOIN bookkeeping_documents d ON d.id=t.document_id WHERE t.id=$1',[req.params.id]);
    if(!result.rowCount) return res.status(404).json({message:'Transaction not found.'});
    res.json({transaction:result.rows[0]});
  });

  async function compareStatement(req, res) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const document = await client.query('SELECT id,document_type FROM bookkeeping_documents WHERE id=$1', [req.params.id]);
      if (!document.rowCount) throw Object.assign(new Error('Statement not found.'), { statusCode: 404 });
      if (!['bank_statement','credit_card_statement'].includes(document.rows[0].document_type)) throw Object.assign(new Error('Choose a bank or credit-card statement.'), { statusCode: 400 });
      const transactions = await client.query('SELECT * FROM bookkeeping_transactions WHERE document_id=$1 ORDER BY transaction_date,id', [req.params.id]);
      if (!transactions.rowCount) throw Object.assign(new Error('Process this statement first.'), { statusCode: 400 });
      const report = statementAudit(await loadBookkeepingAudit(client), req.params.id, transactions.rows);
      await client.query('COMMIT');
      res.json(req.method === 'GET' ? { report } : report);
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    finally { client.release(); }
  }
  routes.post('/api/bookkeeping/documents/:id/reconcile', compareStatement);
  routes.get('/api/bookkeeping/documents/:id/reconcile', compareStatement);

  routes.patch("/api/bookkeeping/transactions/:id", async (req, res) => {
    const body = req.body || {};
    if (body.status && !['approved','pending'].includes(body.status)) return res.status(400).json({message:'Choose pending or approved.'});
    if (body.transaction_type && !['income','expense','refund','transfer','adjustment'].includes(body.transaction_type)) return res.status(400).json({message:'Choose a valid transaction type.'});
    if (body.total != null && (!Number.isFinite(Number(body.total)) || Number(body.total) < 0)) return res.status(400).json({message:'Enter a positive amount and use the transaction type to describe its direction.'});
    if (body.currency != null && !/^[A-Z]{3}$/.test(body.currency)) return res.status(400).json({message:'Use a three-letter currency code such as USD.'});
    if (body.transaction_date != null && (!/^\d{4}-\d{2}-\d{2}$/.test(body.transaction_date) || Number.isNaN(Date.parse(body.transaction_date)) || new Date(body.transaction_date).toISOString().slice(0,10)!==body.transaction_date)) return res.status(400).json({message:'Enter a valid transaction date.'});
    const fields = ["transaction_date", "vendor", "description", "subtotal", "tax", "total", "category", "payment_account", "notes", "status", "transaction_type", "currency"].filter(field => Object.hasOwn(body,field));
    if (!fields.length) return res.status(400).json({message:'No changes supplied.'});
    const values = fields.map(field => body[field]);
    const assignments = fields.map((field,index) => `${field}=$${index+1}`);
    values.push(req.adminUser.id,req.params.id);
    if (body.status === 'approved') assignments.push(`approved_by_admin_user_id=$${values.length-1}`, 'approved_at=NOW()');
    const supplied = field => fields.includes(field) ? `$${fields.indexOf(field)+1}` : field;
    const approvalGuard = body.status === 'approved' ? `AND ${supplied('transaction_date')}::date IS NOT NULL AND length(trim(COALESCE(${supplied('vendor')}::text,'')))>0 AND ${supplied('total')}::numeric>=0` : '';
    const result = await pool.query(`UPDATE bookkeeping_transactions SET ${assignments.join(',')} WHERE id=$${values.length} AND status<>'void' ${approvalGuard} RETURNING *`, values);
    if (!result.rowCount) return res.status(404).json({ message: "Transaction not found." });
    if (req.body.status === "approved") {
      await pool.query("UPDATE bookkeeping_documents SET processing_status='approved' WHERE id = (SELECT document_id FROM bookkeeping_transactions WHERE id = $1::bigint) AND NOT EXISTS (SELECT 1 FROM bookkeeping_transactions WHERE document_id = (SELECT document_id FROM bookkeeping_transactions WHERE id = $1::bigint) AND status = 'pending')", [req.params.id]);
    }
    notify({ reason: "bookkeeping_changed" });
    return res.json({ transaction: result.rows[0] });
  });

  routes.delete("/api/bookkeeping/transactions/:id", async (req, res) => {
    const result = await pool.query("UPDATE bookkeeping_transactions SET status='void' WHERE id = $1 AND status<>'void' RETURNING id", [req.params.id]);
    if (!result.rowCount) return res.status(404).json({ message: "Transaction not found." });
    notify({ reason: "bookkeeping_changed" });
    return res.status(204).end();
  });

}
