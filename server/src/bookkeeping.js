import { createHash } from "node:crypto";
import path from "node:path";
import { CopyObjectCommand, DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import multer from "multer";
import OpenAI from "openai";

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

function jsonObject(text) {
  const match = String(text || "").match(/\{[\s\S]*\}/);
  if (!match) throw new Error("AI did not return structured bookkeeping data.");
  return JSON.parse(match[0]);
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

function normalizedWords(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((word) => word.length > 2);
}

function daysBetween(left, right) {
  if (!left || !right) return 999;
  return Math.abs((new Date(left).getTime() - new Date(right).getTime()) / 86400000);
}

function vendorSimilarity(left, right) {
  const a = new Set(normalizedWords(left));
  const b = new Set(normalizedWords(right));
  if (!a.size || !b.size) return 0;
  return [...a].filter((word) => b.has(word)).length / Math.max(a.size, b.size);
}

function safeFilenamePart(value, fallback) {
  const part = String(value || fallback).trim().replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return part || fallback;
}

async function extractDocument(file, note = "") {
  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not configured.");
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const base64 = file.buffer.toString("base64");
  const input = file.mimetype === "application/pdf" || file.mimetype === "text/csv"
    ? { type: "input_file", filename: file.originalname, file_data: `data:${file.mimetype};base64,${base64}` }
    : { type: "input_image", detail: "high", image_url: `data:${file.mimetype};base64,${base64}` };
      const response = await client.responses.create({
    model: process.env.OPENAI_BOOKKEEPING_MODEL || "gpt-5",
    input: [{ role: "user", content: [
      { type: "input_text", text: `Extract bookkeeping data. Return JSON only with documentType, transactions (array), and confidence. Each transaction must include transactionDate, vendor, description, subtotal, tax, total, currency, category, paymentAccount, transactionType, and lineItems. transactionType MUST be exactly one of: income, expense, transfer, refund, adjustment. Use null when unknown; never invent values. Additional information from the admin: ${String(note || "No additional information provided.")}` },
      input
    ] }]
  });
  return jsonObject(response.output_text);
}

export function registerBookkeepingRoutes(app, { pool }) {
  const bucket = process.env.RAILWAY_BUCKET_NAME || process.env.RAILWAY_BUCKET;
  const storage = createStorageClient();

  app.get("/api/bookkeeping/categories", async (_req, res) => {
    const result = await pool.query("SELECT id, name, category_type FROM bookkeeping_categories WHERE is_active = TRUE ORDER BY category_type, name");
    return res.json({ categories: result.rows });
  });

  app.post("/api/bookkeeping/categories", async (req, res) => {
    const name = String(req.body?.name || "").trim().slice(0, 100);
    const categoryType = ["income", "expense", "other"].includes(req.body?.category_type) ? req.body.category_type : "expense";
    if (!name) return res.status(400).json({ message: "Category name is required." });
    try {
      const result = await pool.query("INSERT INTO bookkeeping_categories (name, category_type) VALUES ($1, $2) RETURNING id, name, category_type", [name, categoryType]);
      return res.status(201).json({ category: result.rows[0] });
    } catch (error) {
      if (error.code === "23505") return res.status(409).json({ message: "That category already exists." });
      throw error;
    }
  });

  app.post("/api/bookkeeping/documents", upload.single("file"), async (req, res) => {
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
    return res.status(201).json({ document: result.rows[0] });
  });

  app.get("/api/bookkeeping/documents", async (_req, res) => {
    const result = await pool.query("SELECT * FROM bookkeeping_documents ORDER BY uploaded_at DESC LIMIT 200");
    return res.json({ documents: result.rows });
  });

  app.get("/api/bookkeeping/documents/:id/download", async (req, res) => {
    if (!storage || !bucket) return res.status(503).json({ message: "Railway Bucket storage is not configured." });
    const result = await pool.query("SELECT storage_key, original_filename FROM bookkeeping_documents WHERE id = $1", [req.params.id]);
    if (!result.rowCount) return res.status(404).json({ message: "Document not found." });
    const url = await getSignedUrl(storage, new GetObjectCommand({ Bucket: bucket, Key: result.rows[0].storage_key, ResponseContentDisposition: `inline; filename=\"${result.rows[0].original_filename.replaceAll('"', '')}\"` }), { expiresIn: 900 });
    return res.json({ url });
  });

  app.delete("/api/bookkeeping/documents/:id", async (req, res) => {
    const result = await pool.query("SELECT storage_key, processing_status FROM bookkeeping_documents WHERE id = $1", [req.params.id]);
    if (!result.rowCount) return res.status(404).json({ message: "Document not found." });
    if (!["uploaded", "queued", "failed", "rejected", "needs_review"].includes(result.rows[0].processing_status)) {
      return res.status(409).json({ message: "Processed documents cannot be deleted from here." });
    }
    if (!storage || !bucket) return res.status(503).json({ message: "Railway Bucket storage is not configured." });
    await storage.send(new DeleteObjectCommand({ Bucket: bucket, Key: result.rows[0].storage_key }));
    await pool.query("DELETE FROM bookkeeping_transactions WHERE document_id = $1 AND status = 'pending'", [req.params.id]);
    await pool.query("DELETE FROM bookkeeping_documents WHERE id = $1", [req.params.id]);
    return res.status(204).end();
  });

  app.post("/api/bookkeeping/documents/:id/process", async (req, res) => {
    const client = await pool.connect();
    try {
      const documentResult = await client.query("SELECT * FROM bookkeeping_documents WHERE id = $1 FOR UPDATE", [req.params.id]);
      if (!documentResult.rowCount) return res.status(404).json({ message: "Document not found." });
      const document = documentResult.rows[0];
      const adminNote = String(req.body?.note || document.metadata?.note || "").trim().slice(0, 4000);
      if (adminNote && JSON.stringify(document.metadata?.note || "") !== JSON.stringify(adminNote)) {
        await client.query("UPDATE bookkeeping_documents SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{note}', to_jsonb($2::text)) WHERE id = $1", [document.id, adminNote]);
        document.metadata = { ...(document.metadata || {}), note: adminNote };
      }
      const storageObject = await storage.send(new GetObjectCommand({ Bucket: bucket, Key: document.storage_key }));
      const chunks = [];
      for await (const chunk of storageObject.Body) chunks.push(chunk);
      const extracted = await extractDocument({ buffer: Buffer.concat(chunks), mimetype: document.mime_type, originalname: document.original_filename }, document.metadata?.note || "");
      const firstTransaction = Array.isArray(extracted.transactions) ? extracted.transactions[0] : null;
      const extension = document.original_filename.includes(".") ? document.original_filename.slice(document.original_filename.lastIndexOf(".")) : "";
      const renamedFilename = `${safeFilenamePart(extracted.documentType, "document")}-${safeFilenamePart(firstTransaction?.vendor, "unknown-vendor")}-${safeFilenamePart(firstTransaction?.transactionDate, new Date().toISOString().slice(0, 10))}${extension}`;
      const renamedKey = `${document.storage_key.slice(0, document.storage_key.lastIndexOf("/") + 1)}${document.id}-${renamedFilename}`;
      if (renamedKey !== document.storage_key) {
        await storage.send(new CopyObjectCommand({ Bucket: bucket, CopySource: `${bucket}/${document.storage_key}`, Key: renamedKey, ContentType: document.mime_type, MetadataDirective: "REPLACE" }));
        await storage.send(new DeleteObjectCommand({ Bucket: bucket, Key: document.storage_key }));
      }
      await client.query("BEGIN");
      await client.query("INSERT INTO bookkeeping_extractions (document_id, model, extracted_json, confidence) VALUES ($1,$2,$3,$4)", [document.id, process.env.OPENAI_BOOKKEEPING_MODEL || "gpt-5", extracted, extracted.confidence || null]);
      for (const item of Array.isArray(extracted.transactions) ? extracted.transactions : []) {
        const tx = await client.query(`INSERT INTO bookkeeping_transactions (document_id, uploaded_by_admin_user_id, transaction_date, vendor, description, subtotal, tax, total, currency, category, payment_account, transaction_type, ai_confidence) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`, [document.id, req.adminUser.id, item.transactionDate || null, item.vendor || null, item.description || null, item.subtotal ?? null, item.tax ?? null, item.total ?? 0, item.currency || "USD", item.category || null, item.paymentAccount || null, normalizeTransactionType(item.transactionType), item.confidence || extracted.confidence || null]);
        for (const line of Array.isArray(item.lineItems) ? item.lineItems : []) await client.query("INSERT INTO bookkeeping_line_items (transaction_id, description, quantity, unit_price, amount, category) VALUES ($1,$2,$3,$4,$5,$6)", [tx.rows[0].id, line.description || "Item", line.quantity ?? null, line.unitPrice ?? null, line.amount ?? 0, line.category || null]);
      }
      await client.query("UPDATE bookkeeping_documents SET original_filename=$2, storage_key=$3, document_type=$4, processing_status='needs_review', processed_at=NOW(), error_message=NULL WHERE id=$1", [document.id, renamedFilename, renamedKey, extracted.documentType || "other"]);
      await client.query("COMMIT");
      return res.json({ extracted });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      await pool.query("UPDATE bookkeeping_documents SET processing_status='failed', error_message=$2 WHERE id=$1", [req.params.id, error.message]);
      return res.status(500).json({ message: error.message });
    } finally { client.release(); }
  });

  app.get("/api/bookkeeping/transactions", async (req, res) => {
    const requestedStatus = String(req.query.status || "pending");
    const statusClause = requestedStatus === "all" ? "t.status <> 'void'" : "t.status = $1";
    const params = requestedStatus === "all" ? [] : [requestedStatus];
    const result = await pool.query(`SELECT t.*, d.original_filename AS source_filename FROM bookkeeping_transactions t LEFT JOIN bookkeeping_documents d ON d.id = t.document_id WHERE ${statusClause} ORDER BY t.transaction_date DESC NULLS LAST, t.id DESC LIMIT 500`, params);
    return res.json({ transactions: result.rows });
  });

  app.post("/api/bookkeeping/documents/:id/reconcile", async (req, res) => {
    const statement = await pool.query("SELECT id, document_type FROM bookkeeping_documents WHERE id = $1", [req.params.id]);
    if (!statement.rowCount) return res.status(404).json({ message: "Statement document not found." });
    if (!["bank_statement", "credit_card_statement"].includes(statement.rows[0].document_type)) return res.status(400).json({ message: "Only bank and credit-card statements can be reconciled." });
    const statementTransactions = await pool.query("SELECT * FROM bookkeeping_transactions WHERE document_id = $1 ORDER BY transaction_date, id", [req.params.id]);
    const receiptTransactions = await pool.query(`SELECT t.*, d.original_filename AS source_filename FROM bookkeeping_transactions t JOIN bookkeeping_documents d ON d.id = t.document_id WHERE d.document_type IN ('receipt', 'invoice') AND t.document_id <> $1 AND t.status <> 'void'`, [req.params.id]);
    const usedReceipts = new Set();
    const matches = [];
    for (const bankTransaction of statementTransactions.rows) {
      let best = null;
      for (const receipt of receiptTransactions.rows) {
        if (usedReceipts.has(receipt.id)) continue;
        const amountDifference = Math.abs(Number(bankTransaction.total || 0) - Number(receipt.total || 0));
        const dateDistance = daysBetween(bankTransaction.transaction_date, receipt.transaction_date);
        const vendorScore = vendorSimilarity(bankTransaction.vendor, receipt.vendor);
        const amountScore = amountDifference <= 0.01 ? 1 : 0;
        const dateScore = dateDistance <= 3 ? 1 : 0;
        const score = amountScore * 0.6 + dateScore * 0.2 + vendorScore * 0.2;
        if (!best || score > best.score) best = { receipt, score, amountDifference, dateDistance, vendorScore };
      }
      if (best && best.score >= 0.8) {
        usedReceipts.add(best.receipt.id);
        matches.push({ statementTransaction: bankTransaction, receiptTransaction: best.receipt, status: "matched", score: best.score, details: best });
      } else {
        matches.push({ statementTransaction: bankTransaction, receiptTransaction: null, status: best && best.score >= 0.4 ? "possible_match" : "unmatched_statement", score: best?.score || 0, details: best || {} });
      }
    }
    const unmatchedReceipts = receiptTransactions.rows.filter((receipt) => !usedReceipts.has(receipt.id));
    const run = await pool.query("INSERT INTO bookkeeping_reconciliation_runs (statement_document_id, created_by_admin_user_id, summary_json) VALUES ($1,$2,$3) RETURNING id", [req.params.id, req.adminUser.id, JSON.stringify({ matched: matches.filter((item) => item.status === "matched").length, possible: matches.filter((item) => item.status === "possible_match").length, unmatchedStatement: matches.filter((item) => item.status === "unmatched_statement").length, unmatchedReceipts: unmatchedReceipts.length })]);
    for (const match of matches) await pool.query("INSERT INTO bookkeeping_reconciliation_matches (run_id, statement_transaction_id, receipt_transaction_id, match_status, match_score, details) VALUES ($1,$2,$3,$4,$5,$6)", [run.rows[0].id, match.statementTransaction.id, match.receiptTransaction?.id || null, match.status, match.score, JSON.stringify({ amountDifference: match.details.amountDifference, dateDistance: match.details.dateDistance, vendorScore: match.details.vendorScore })]);
    return res.json({ runId: run.rows[0].id, matched: matches.filter((item) => item.status === "matched"), possibleMatches: matches.filter((item) => item.status === "possible_match"), unmatchedStatement: matches.filter((item) => item.status === "unmatched_statement"), unmatchedReceipts });
  });

  app.patch("/api/bookkeeping/transactions/:id", async (req, res) => {
    const fields = ["transaction_date", "vendor", "description", "subtotal", "tax", "total", "category", "payment_account", "notes", "status"];
    const values = fields.map((field) => req.body[field]);
    const result = await pool.query(`UPDATE bookkeeping_transactions SET transaction_date=$1,vendor=$2,description=$3,subtotal=$4,tax=$5,total=$6,category=$7,payment_account=$8,notes=$9,status=COALESCE($10,status),approved_by_admin_user_id=CASE WHEN $10='approved' THEN $11 ELSE approved_by_admin_user_id END,approved_at=CASE WHEN $10='approved' THEN NOW() ELSE approved_at END WHERE id=$12 RETURNING *`, [...values, req.adminUser.id, req.params.id]);
    if (!result.rowCount) return res.status(404).json({ message: "Transaction not found." });
    if (req.body.status === "approved") {
      await pool.query("UPDATE bookkeeping_documents SET processing_status='approved' WHERE id = (SELECT document_id FROM bookkeeping_transactions WHERE id = $1) AND NOT EXISTS (SELECT 1 FROM bookkeeping_transactions WHERE document_id = (SELECT document_id FROM bookkeeping_transactions WHERE id = $1) AND status = 'pending')", [req.params.id]);
    }
    return res.json({ transaction: result.rows[0] });
  });

  app.delete("/api/bookkeeping/transactions/:id", async (req, res) => {
    const result = await pool.query("DELETE FROM bookkeeping_transactions WHERE id = $1 RETURNING id", [req.params.id]);
    if (!result.rowCount) return res.status(404).json({ message: "Transaction not found." });
    return res.status(204).end();
  });

  app.get("/api/bookkeeping/reports/profit-loss", async (req, res) => {
    const from = String(req.query.from || "1900-01-01");
    const to = String(req.query.to || "2999-12-31");
    const result = await pool.query(`SELECT COALESCE(SUM(CASE WHEN transaction_type='income' THEN total ELSE 0 END),0) AS revenue, COALESCE(SUM(CASE WHEN transaction_type='expense' THEN total ELSE 0 END),0) AS expenses, category, transaction_type FROM bookkeeping_transactions WHERE status='approved' AND transaction_date BETWEEN $1 AND $2 GROUP BY category, transaction_type ORDER BY transaction_type, category`, [from, to]);
    const revenue = result.rows.filter((row) => row.transaction_type === "income").reduce((sum, row) => sum + Number(row.revenue || 0), 0);
    const expenses = result.rows.filter((row) => row.transaction_type === "expense").reduce((sum, row) => sum + Number(row.expenses || 0), 0);
    return res.json({ reportType: "profit_loss", periodStart: from, periodEnd: to, revenue, expenses, netProfit: revenue - expenses, rows: result.rows });
  });
}
