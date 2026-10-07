import { createHash } from "node:crypto";
import path from "node:path";
import { CopyObjectCommand, DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import multer from "multer";
import OpenAI from "openai";
import { extractBookkeepingDocument } from "./bookkeeping-extraction.js";
import { reconcileTransactions } from "./bookkeeping-reconciliation.js";
import { bookkeepingRoutes } from "./bookkeeping-http.js";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (_req, file, callback) => {
    const allowed = new Set(["application/pdf", "image/jpeg", "image/png", "image/webp", "text/csv", "application/msword", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "application/vnd.ms-excel", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"]);
    callback(null, allowed.has(file.mimetype));
  }
});

function createStorageClient() {
  if (!process.env.RAILWAY_BUCKET_ENDPOINT || !process.env.RAILWAY_BUCKET_ACCESS_KEY || !process.env.RAILWAY_BUCKET_SECRET_KEY) return null;
  return new S3Client({
    endpoint: process.env.RAILWAY_BUCKET_ENDPOINT,
    region: process.env.RAILWAY_BUCKET_REGION || "auto",
    forcePathStyle: true,
    credentials: { accessKeyId: process.env.RAILWAY_BUCKET_ACCESS_KEY, secretAccessKey: process.env.RAILWAY_BUCKET_SECRET_KEY }
  });
}

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
  const bucket = process.env.RAILWAY_BUCKET_NAME || process.env.RAILWAY_BUCKET;
  const storage = createStorageClient();

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
    if (!storage || !bucket) return res.status(503).json({ message: "Railway Bucket storage is not configured." });
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
    const result = await pool.query("SELECT * FROM bookkeeping_documents ORDER BY uploaded_at DESC LIMIT 200");
    return res.json({ documents: result.rows });
  });

  routes.get("/api/bookkeeping/documents/:id/download", async (req, res) => {
    if (!storage || !bucket) return res.status(503).json({ message: "Railway Bucket storage is not configured." });
    const result = await pool.query("SELECT storage_key, original_filename, mime_type FROM bookkeeping_documents WHERE id = $1", [req.params.id]);
    if (!result.rowCount) return res.status(404).json({ message: "Document not found." });
    const url = await getSignedUrl(storage, new GetObjectCommand({ Bucket: bucket, Key: result.rows[0].storage_key, ResponseContentDisposition: `inline; filename=\"${result.rows[0].original_filename.replaceAll('"', '')}\"` }), { expiresIn: 900 });
    return res.json({ url, mimeType: result.rows[0].mime_type, filename: result.rows[0].original_filename });
  });

  routes.delete("/api/bookkeeping/documents/:id", async (req, res) => {
    const result = await pool.query("SELECT storage_key, processing_status FROM bookkeeping_documents WHERE id = $1", [req.params.id]);
    if (!result.rowCount) return res.status(404).json({ message: "Document not found." });
    if (!["uploaded", "queued", "failed", "rejected", "needs_review"].includes(result.rows[0].processing_status)) {
      return res.status(409).json({ message: "Processed documents cannot be deleted from here." });
    }
    if (!storage || !bucket) return res.status(503).json({ message: "Railway Bucket storage is not configured." });
    const records = await pool.query('SELECT id FROM bookkeeping_transactions WHERE document_id=$1 LIMIT 1',[req.params.id]);
    if(records.rowCount) return res.status(409).json({message:'Preserve processed source documents. Exclude individual transactions from the review panel instead.'});
    await pool.query("DELETE FROM bookkeeping_documents WHERE id = $1", [req.params.id]);
    await storage.send(new DeleteObjectCommand({ Bucket: bucket, Key: result.rows[0].storage_key })).catch(()=>console.warn('An unused bookkeeping upload could not be removed from storage.'));
    notify({ reason: "bookkeeping_changed" });
    return res.status(204).end();
  });

  async function processDocument(req, res) {
    if (!storage || !bucket) return res.status(503).json({ message: "Railway Bucket storage is not configured." });
    const client = await pool.connect();
    let claimed = false;
    let processingLockHeld = false;
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
      const storageObject = await storage.send(new GetObjectCommand({ Bucket: bucket, Key: document.storage_key }));
      const chunks = [];
      for await (const chunk of storageObject.Body) chunks.push(chunk);
      const categories = await client.query("SELECT name, category_type FROM bookkeeping_categories WHERE is_active = TRUE ORDER BY category_type, name");
      const extracted = await extractDocument({ buffer: Buffer.concat(chunks), mimetype: document.mime_type, originalname: document.original_filename }, document.metadata?.note || "", categories.rows);
      const firstTransaction = Array.isArray(extracted.transactions) ? extracted.transactions[0] : null;
      const extension = document.original_filename.includes(".") ? document.original_filename.slice(document.original_filename.lastIndexOf(".")) : "";
      const renamedFilename = `${safeFilenamePart(extracted.documentType, "document")}-${safeFilenamePart(firstTransaction?.vendor, "unknown-vendor")}-${safeFilenamePart(firstTransaction?.transactionDate, new Date().toISOString().slice(0, 10))}${extension}`;
      const renamedKey = `${document.storage_key.slice(0, document.storage_key.lastIndexOf("/") + 1)}${document.id}-${renamedFilename}`;
      if (renamedKey !== document.storage_key) {
        await storage.send(new CopyObjectCommand({ Bucket: bucket, CopySource: `${bucket}/${document.storage_key}`, Key: renamedKey, ContentType: document.mime_type, MetadataDirective: "REPLACE" }));
      }
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
      if (claimed) {
        await pool.query("UPDATE bookkeeping_documents SET processing_status='failed', error_message=$2,metadata=COALESCE(metadata,'{}'::jsonb) || '{\"ai_queued\":false}'::jsonb WHERE id=$1", [req.params.id, error.message]);
        notify({ reason: "bookkeeping_changed" });
      }
      return res.status(500).json({ message: error.message });
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
    const result = await pool.query(`SELECT t.*, d.original_filename AS source_filename FROM bookkeeping_transactions t LEFT JOIN bookkeeping_documents d ON d.id = t.document_id WHERE ${statusClause} ORDER BY ${order} LIMIT ${limit}`, params);
    return res.json({ transactions: result.rows });
  });
  routes.get('/api/bookkeeping/transactions/:id', async(req,res) => {
    const result = await pool.query('SELECT t.*,d.original_filename AS source_filename FROM bookkeeping_transactions t LEFT JOIN bookkeeping_documents d ON d.id=t.document_id WHERE t.id=$1',[req.params.id]);
    if(!result.rowCount) return res.status(404).json({message:'Transaction not found.'});
    res.json({transaction:result.rows[0]});
  });

  routes.post("/api/bookkeeping/documents/:id/reconcile", async (req, res) => {
    const statement = await pool.query("SELECT id, document_type FROM bookkeeping_documents WHERE id=$1", [req.params.id]);
    if (!statement.rowCount) return res.status(404).json({message:"Statement not found."});
    if (!["bank_statement","credit_card_statement"].includes(statement.rows[0].document_type)) return res.status(400).json({message:"Choose a bank or credit-card statement."});
    const statements = await pool.query("SELECT * FROM bookkeeping_transactions WHERE document_id=$1 AND status<>'void' ORDER BY transaction_date,id", [req.params.id]);
    if (!statements.rowCount) return res.status(400).json({message:"Process this statement first, or choose a statement with transactions."});
    const receipts = await pool.query(`SELECT t.*,d.original_filename AS source_filename FROM bookkeeping_transactions t LEFT JOIN bookkeeping_documents d ON d.id=t.document_id WHERE (d.document_type IN ('receipt','invoice') OR t.document_id IS NULL) AND t.document_id IS DISTINCT FROM $1::bigint AND t.status<>'void' AND t.transaction_date BETWEEN (SELECT min(transaction_date)-3 FROM bookkeeping_transactions WHERE document_id=$1 AND status<>'void') AND (SELECT max(transaction_date)+3 FROM bookkeeping_transactions WHERE document_id=$1 AND status<>'void') ORDER BY t.transaction_date,t.id`, [req.params.id]);
    const report = reconcileTransactions(statements.rows,receipts.rows);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const run = await client.query("INSERT INTO bookkeeping_reconciliation_runs (statement_document_id,created_by_admin_user_id,summary_json) VALUES ($1,$2,$3) RETURNING id", [req.params.id,req.adminUser.id,JSON.stringify({...report,matchedCount:report.matched.length})]);
      for (const match of report.consolidated) await client.query("INSERT INTO bookkeeping_reconciliation_matches (run_id,statement_transaction_id,receipt_transaction_id,match_status,match_score,details) VALUES ($1,$2,$3,$4,$5,$6)",[run.rows[0].id,match.statementTransaction.id,match.receiptTransaction?.id || null,match.status,match.score,JSON.stringify(match.details)]);
      await client.query("COMMIT");
      notify({reason:"bookkeeping_changed"});
      return res.json({runId:run.rows[0].id,...report});
    } catch(error) { await client.query("ROLLBACK"); return res.status(500).json({message:error.message}); } finally {client.release();}
  });

  routes.get("/api/bookkeeping/documents/:id/reconcile", async (req,res) => {
    const result = await pool.query("SELECT id,created_at,summary_json FROM bookkeeping_reconciliation_runs WHERE statement_document_id=$1 ORDER BY id DESC LIMIT 1",[req.params.id]);
    const run = result.rows[0];
    res.json({report:run && Array.isArray(run.summary_json?.matched) ? {runId:run.id,createdAt:run.created_at,...run.summary_json} : null});
  });

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
    const approvalGuard = body.status === 'approved' ? `AND ${supplied('transaction_date')} IS NOT NULL AND length(trim(COALESCE(${supplied('vendor')},'')))>0 AND ${supplied('total')}>=0` : '';
    const result = await pool.query(`UPDATE bookkeeping_transactions SET ${assignments.join(',')} WHERE id=$${values.length} AND status<>'void' ${approvalGuard} RETURNING *`, values);
    if (!result.rowCount) return res.status(404).json({ message: "Transaction not found." });
    if (req.body.status === "approved") {
      await pool.query("UPDATE bookkeeping_documents SET processing_status='approved' WHERE id = (SELECT document_id FROM bookkeeping_transactions WHERE id = $1) AND NOT EXISTS (SELECT 1 FROM bookkeeping_transactions WHERE document_id = (SELECT document_id FROM bookkeeping_transactions WHERE id = $1) AND status = 'pending')", [req.params.id]);
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
