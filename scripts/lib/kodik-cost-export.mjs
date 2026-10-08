// Local export ingestion only. No provider calls, credentials or database access.
import { readFileSync, statSync } from 'node:fs';
import { rubUnits, rubString } from './ai-cost-report.mjs';

function csvRecords(text) {
  const records = []; let row = [], value = '', quoted = false, closed = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') { value += '"'; i++; }
      else if (char === '"') { quoted = false; closed = true; }
      else value += char;
    } else if (char === '"' && !value && !closed) quoted = true;
    else if (char === ';' || char === '\n' || char === '\r') {
      row.push(value); value = ''; closed = false;
      if (char !== ';') {
        if (char === '\r' && text[i + 1] === '\n') i++;
        if (row.some(cell => cell !== '')) records.push(row);
        row = [];
      }
    } else {
      if (closed || char === '"') throw new Error('Malformed CSV quoting');
      value += char;
    }
    if (value.length > 4096 || row.length > 64 || records.length > 500001) throw new Error('Export limits exceeded');
  }
  if (quoted) throw new Error('Unclosed CSV quote');
  if (value || row.length || closed) { row.push(value); records.push(row); }
  const headers = records.shift();
  const required = ['request_id','id','api_key_name','timestamp','model_id','status','input_tokens','output_tokens','cost_rub'];
  if (!headers || new Set(headers).size !== headers.length || !required.every(key => headers.includes(key))) {
    throw new Error('Required CSV columns are missing or repeated');
  }
  return records.map(cells => {
    if (cells.length !== headers.length) throw new Error('CSV row width mismatch');
    return Object.fromEntries(headers.map((key, index) => [key, cells[index]]));
  });
}

function timestamp(value, naiveTimezone) {
  if (typeof value !== 'string') throw new Error('Export timestamp missing');
  let normalized = value;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?$/.test(value)) {
    if (naiveTimezone !== 'UTC') throw new Error('Naive timestamps require explicitly verified UTC');
    normalized += 'Z';
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(normalized)
    || !Number.isFinite(Date.parse(normalized))) throw new Error('Invalid export timestamp');
  if (Number(normalized.slice(11,13)) > 23 || Number(normalized.slice(14,16)) > 59 || Number(normalized.slice(17,19)) > 59) {
    throw new Error('Invalid export time');
  }
  // Date.parse silently normalizes February 30. Refuse that instead of changing evidence.
  const day = normalized.slice(0,10);
  if (new Date(`${day}T00:00:00Z`).toISOString().slice(0,10) !== day) throw new Error('Invalid export date');
  return new Date(normalized).toISOString();
}
function tokens(value) {
  if (value === '' || value == null) return null;
  const number = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < 0 || number > 2147483647) {
    throw new Error('Invalid export token count');
  }
  return number;
}

export function parseKodikCostExport(text, { format = 'json', naiveTimezone } = {}) {
  if (naiveTimezone != null && naiveTimezone !== 'UTC') throw new Error('Only verified UTC is supported for naive timestamps');
  text = text.replace(/^\uFEFF/, '');
  const parsed = format === 'csv' ? csvRecords(text) : JSON.parse(text);
  const rows = Array.isArray(parsed) ? parsed : parsed?.schemaVersion === 1 ? parsed.rows : null;
  if (!Array.isArray(rows) || rows.length > 500000) throw new Error('Expected bounded export array');
  return rows.map(row => {
    if (!row || typeof row !== 'object' || !row.api_key_name || typeof row.api_key_name !== 'string') {
      throw new Error('Explicit API key name is required in every row');
    }
    const originalCost = row.cost_rub;
    const cost = typeof originalCost === 'string' && format === 'csv' ? originalCost.replace(',', '.') : originalCost;
    const units = cost == null || cost === '' ? null : rubUnits(cost);
    if (cost != null && cost !== '' && units === null) throw new Error('Invalid RUB debit');
    return {
      id: row.id, request_id: row.request_id, api_key_name: row.api_key_name,
      timestamp: timestamp(row.timestamp, naiveTimezone), model_id: row.model_id, status: row.status,
      input_tokens: tokens(row.input_tokens ?? row.tokens_in), output_tokens: tokens(row.output_tokens ?? row.tokens_out),
      cost_rub: units === null ? null : rubString(units),
    };
  });
}

export function loadKodikCostExport(path, options = {}) {
  if (statSync(path).size > 128 * 1024 * 1024) throw new Error('Export size limit exceeded');
  return parseKodikCostExport(readFileSync(path, 'utf8'), { ...options,
    format: /\.csv$/i.test(path) ? 'csv' : 'json' });
}
