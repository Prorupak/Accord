import Papa from "papaparse";
import { caseFold, rowIdOf, sha256Hex } from "./identity";
import { LIMITS, PARSER_POLICY_VERSION, type Column, type Dataset, type Result, type Row, type Side } from "./types";

export type ParseErrorCode =
  | "empty_file"
  | "file_too_large"
  | "invalid_utf8"
  | "binary_content"
  | "malformed_quotes"
  | "mixed_line_endings"
  | "missing_header"
  | "column_count"
  | "empty_header"
  | "duplicate_header"
  | "row_width"
  | "cell_too_long"
  | "record_count";

// Messages and locations only; never cell contents, so errors are safe to log or display.
export type ParseError = {
  code: ParseErrorCode;
  message: string;
  recordIndex?: number; // 0-based data record index (header excluded, blank records skipped)
  columnIndex?: number;
};

const fail = (code: ParseErrorCode, message: string, at: Omit<ParseError, "code" | "message"> = {}) =>
  ({ ok: false, error: { code, message, ...at } }) as const;

const codePoints = (s: string) => [...s].length;

const isBlankRecord = (cells: string[]) => cells.length === 1 && cells[0] === "";

// Spec §4.1. Rejects rather than repairs: every failure is a typed error, nothing is dropped
// silently except truly blank lines, which are counted.
export async function parseDataset(side: Side, fileName: string, bytes: Uint8Array): Promise<Result<Dataset, ParseError>> {
  if (bytes.byteLength === 0) return fail("empty_file", "The file is empty.");
  if (bytes.byteLength > LIMITS.maxFileBytes)
    return fail("file_too_large", `The file exceeds ${LIMITS.maxFileBytes} bytes.`);

  const datasetId = await sha256Hex(bytes);

  let text: string;
  try {
    // fatal: invalid UTF-8 throws instead of becoming U+FFFD. The default ignoreBOM:false
    // strips a leading BOM from the decoded text only; the hash above covers the original bytes.
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return fail("invalid_utf8", "The file is not valid UTF-8.");
  }
  if (text.includes("\u0000")) return fail("binary_content", "The file contains NUL bytes.");

  const parsed = Papa.parse<string[]>(text, {
    header: false,
    dynamicTyping: false,
    delimiter: ",",
    skipEmptyLines: false,
  });
  if (parsed.errors.length > 0) {
    const quotes = parsed.errors.some((e) => e.type === "Quotes");
    return quotes
      ? fail("malformed_quotes", "The file has an unterminated or malformed quoted field.")
      : fail("malformed_quotes", "The file could not be parsed as CSV.");
  }

  const records = parsed.data;
  // A final line terminator yields one trailing [""]; it ends the last record, it is not a record.
  if (records.length > 0 && isBlankRecord(records[records.length - 1]) && /[\r\n]$/.test(text)) records.pop();

  const header = records[0];
  if (!header || isBlankRecord(header)) return fail("missing_header", "The first line must be a header.");
  if (header.length < LIMITS.minColumns || header.length > LIMITS.maxColumns)
    return fail("column_count", `Files need ${LIMITS.minColumns}–${LIMITS.maxColumns} columns.`);

  // Papa picks one line terminator from the first one it sees. A bare CR left at the end of a
  // cell means the file mixes CRLF and LF outside quotes; reject instead of keeping the stray CR.
  const strayCr = parsed.meta.linebreak === "\n" ? (s: string) => s.endsWith("\r") : () => false;

  // Check the header as an array before anything is keyed by it, so duplicates can't be renamed.
  const seen = new Set<string>();
  for (const [i, h] of header.entries()) {
    if (strayCr(h)) return fail("mixed_line_endings", "The file mixes CRLF and LF line endings.");
    if (codePoints(h) > LIMITS.maxCellCodePoints)
      return fail("cell_too_long", "A header cell is too long.", { columnIndex: i });
    if (h.trim() === "") return fail("empty_header", "Every column needs a header.", { columnIndex: i });
    const key = caseFold(h.trim());
    if (seen.has(key)) return fail("duplicate_header", "Headers must be unique ignoring case and surrounding spaces.", { columnIndex: i });
    seen.add(key);
  }

  const rows: Row[] = [];
  let ignoredBlankRecords = 0;
  for (const cells of records.slice(1)) {
    if (isBlankRecord(cells)) {
      ignoredBlankRecords++;
      continue;
    }
    const index = rows.length;
    if (cells.length !== header.length)
      return fail("row_width", `A record has ${cells.length} fields; the header has ${header.length}.`, { recordIndex: index });
    for (const [c, cell] of cells.entries()) {
      if (strayCr(cell)) return fail("mixed_line_endings", "The file mixes CRLF and LF line endings.", { recordIndex: index });
      if (codePoints(cell) > LIMITS.maxCellCodePoints)
        return fail("cell_too_long", `A cell exceeds ${LIMITS.maxCellCodePoints} characters.`, { recordIndex: index, columnIndex: c });
    }
    rows.push(Object.freeze({ id: rowIdOf(side, datasetId, index), index, cells: Object.freeze([...cells]) }));
  }
  if (rows.length < LIMITS.minRecords || rows.length > LIMITS.maxRecords)
    return fail("record_count", `Files need ${LIMITS.minRecords}–${LIMITS.maxRecords} data records; this one has ${rows.length}.`);

  const columns: Column[] = header.map((h, index) => Object.freeze({ id: `c${index}`, index, header: h }));
  return {
    ok: true,
    value: Object.freeze({
      side,
      id: datasetId,
      fileName,
      byteLength: bytes.byteLength,
      columns: Object.freeze(columns),
      rows: Object.freeze(rows),
      parse: Object.freeze({ policyVersion: PARSER_POLICY_VERSION, ignoredBlankRecords }),
    }),
  };
}
