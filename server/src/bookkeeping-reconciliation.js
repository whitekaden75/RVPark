const dateKey = value => value instanceof Date ? value.toISOString().slice(0, 10) : String(value || '').slice(0, 10);
const words = value => new Set(String(value || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(word => word.length > 2));
const currency = row => (row.currency || 'USD').toUpperCase();
const amount = row => Math.round(Math.abs(Number(row.total || 0)) * 100);

export function reconcileTransactions(statementRows, receiptRows) {
  const statements = statementRows.filter(row => row.status !== 'void');
  const receipts = receiptRows.filter(row => row.status !== 'void');
  const duplicateCandidates = (rows, source) => {
    const seen = new Map(), duplicates = [];
    for (const row of rows) {
      const vendor = [...words(row.vendor || row.description)].join(' ');
      if (!dateKey(row.transaction_date) || !vendor) continue;
      const key = [dateKey(row.transaction_date), amount(row), currency(row), row.transaction_type, vendor].join('|');
      if (seen.has(key)) duplicates.push({source, duplicate:row, original:seen.get(key), reason:'Same date, amount, currency, type and vendor. Confirm before consolidating.'});
      else seen.set(key,row);
    }
    return duplicates;
  };
  const used = new Set();
  const matches = statements.map(statement => {
    const candidates = receipts.filter(receipt => !used.has(String(receipt.id)) && currency(receipt) === currency(statement) && receipt.transaction_type === statement.transaction_type && amount(receipt) === amount(statement)).map(receipt => {
      const distance = Math.abs((Date.parse(dateKey(statement.transaction_date)) - Date.parse(dateKey(receipt.transaction_date))) / 86400000);
      const a = words(statement.vendor), b = words(receipt.vendor);
      const vendor = a.size && b.size ? [...a].filter(word => b.has(word)).length / Math.min(a.size,b.size) : 0;
      return {receipt,distance,vendor,score:0.6 + (distance <= 3 ? 0.15 : 0) + vendor*0.25};
    }).filter(candidate => candidate.distance <= 3).sort((a,b) => b.score-a.score || a.distance-b.distance);
    const best = candidates[0];
    const ambiguous = best && candidates[1] && Math.abs(best.score-candidates[1].score) < 0.05;
    const matched = best && best.vendor >= 0.4 && !ambiguous;
    if(matched) used.add(String(best.receipt.id));
    return {statementTransaction:statement,receiptTransaction:best?.receipt || null,status:matched ? 'matched' : best ? 'possible_match' : 'unmatched_statement',score:best?.score || 0,details:{reason:ambiguous ? 'Several receipts match. Choose manually.' : matched ? 'Amount, currency, type, date and vendor agree.' : best ? 'Amount and date agree; verify the vendor.' : 'No receipt for this amount, date and type.'}};
  });
  return {matched:matches.filter(row => row.status === 'matched'),possibleMatches:matches.filter(row => row.status === 'possible_match'),unmatchedStatement:matches.filter(row => row.status === 'unmatched_statement'),duplicates:[...duplicateCandidates(statements,'statement'),...duplicateCandidates(receipts,'receipt')],unmatchedReceipts:receipts.filter(row => !used.has(String(row.id))),consolidated:matches};
}
