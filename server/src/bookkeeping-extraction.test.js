import test from "node:test";
import assert from "node:assert/strict";
import { extractBookkeepingDocument } from "./bookkeeping-extraction.js";

const file = { buffer: Buffer.from("sample receipt"), mimetype: "image/png", originalname: "receipt.png" };
const categories = [
  { name: "Vehicle & Fuel", category_type: "expense" },
  { name: "Supplies", category_type: "expense" },
  { name: "Revenue", category_type: "income" },
  { name: "Custom park maintenance", category_type: "expense" },
  { name: "Undetermined", category_type: "expense" },
  { name: "Inactive", category_type: "expense", is_active: false },
];
const mockClient = (response, inspect = () => {}) => ({ responses: { create: async request => { inspect(request); return response; } } });
const completed = transactions => ({ status: "completed", output_text: JSON.stringify({ documentType: "receipt", confidence: 0.8, transactions }) });

test("extraction includes custom categories and requires a concrete suggestion for purchases", async () => {
  const result = await extractBookkeepingDocument(mockClient(completed([{ transactionType: "expense", category: "Vehicle & Fuel", tax: null, confidence: 0.6 }]), request => {
    const format = request.text.format;
    assert.equal(request.model, "gpt-5");
    assert.equal(format.type, "json_schema");
    assert.equal(format.strict, true);
    const schema = format.schema.properties.transactions.items.anyOf[0].properties;
    assert.ok(schema.category.enum.includes("Custom park maintenance"));
    assert.ok(!schema.category.enum.includes("Undetermined"));
    assert.ok(!schema.category.enum.includes("Inactive"));
    assert.ok(!schema.category.enum.includes(null));
    assert.ok(schema.tax.type.includes("null"));
    assert.match(request.instructions, /best-supported guess/);
    assert.match(request.input[0].content[0].text, /maintenance truck/);
  }), file, { categories, note: "Diesel for the maintenance truck" });
  assert.equal(result.transactions[0].category, "Vehicle & Fuel");
  assert.equal(result.transactions[0].tax, null);
});

test("invalid or undetermined purchase categories cannot reach persistence", async () => {
  for (const category of [null, "", "Undetermined", "Made-up category"]) {
    await assert.rejects(extractBookkeepingDocument(mockClient(completed([{ transactionType: "expense", category }])), file, { categories }), /outside your active catalog/);
  }
});

test("transfers may stay neutral when there is no compatible category", async () => {
  const result = await extractBookkeepingDocument(mockClient(completed([{ transactionType: "transfer", category: null }])), file, { categories });
  assert.equal(result.transactions[0].category, null);
  assert.equal(result.transactions[0].transactionType, "transfer");
});

test("refusals and incomplete output do not create partial records", async () => {
  await assert.rejects(extractBookkeepingDocument(mockClient({ status: "incomplete", output_text: "{}" }), file, { categories }), /did not complete/);
  await assert.rejects(extractBookkeepingDocument(mockClient({ status: "completed", output: [{ content: [{ type: "refusal" }] }] }), file, { categories }), /could not process/);
  await assert.rejects(extractBookkeepingDocument(mockClient({ status: "completed", output_text: "{}" }), file, { categories }), /transaction list/);
});

test("files use the proper input type and empty catalogs fail before an API call", async () => {
  await extractBookkeepingDocument(mockClient(completed([]), request => assert.equal(request.input[0].content[1].type, "input_file")), { ...file, mimetype: "application/pdf" }, { categories });
  await assert.rejects(extractBookkeepingDocument(mockClient({}, () => assert.fail("API should not run")), file, { categories: [] }), /active bookkeeping category/);
});
