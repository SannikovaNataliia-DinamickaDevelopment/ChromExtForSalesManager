import * as fs from 'fs';
import { Injectable, Logger } from '@nestjs/common';
import { google, sheets_v4 } from 'googleapis';
import { formatKyivDate, formatKyivDateTime } from '../common/format-kyiv-time';
import { Destination, JobLeadRecord, SaveResult } from './destination.interface';

const SHEET_NAME = 'Leads';

function cell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

// CLAUDE.md's stated column order: "published_at (first) · external_job_id · is_it · short
// description · company_website · plus existing fields". Column order matters: findRow()
// below assumes published_at is A, external_job_id is B, and source_url is E.
const IS_IT_LABELS: Record<JobLeadRecord['is_it'], string> = { it: 'IT', not_it: 'not-IT', unprocessed: '' };

const COLUMNS: { label: string; value: (r: JobLeadRecord) => string }[] = [
  { label: 'published_at', value: (r) => formatKyivDate(r.published_at) },
  { label: 'external_job_id', value: (r) => cell(r.external_job_id) },
  // CLAUDE.md scope C: broad IT/not-IT flag from Gemini. Never deletes non-IT leads, only flags.
  { label: 'is_it', value: (r) => IS_IT_LABELS[r.is_it] },
  { label: 'source_site', value: (r) => cell(r.source_site) },
  { label: 'source_url', value: (r) => cell(r.source_url) },
  { label: 'job_title', value: (r) => cell(r.job_title) },
  { label: 'company', value: (r) => cell(r.company) },
  { label: 'location', value: (r) => cell(r.location) },
  { label: 'salary', value: (r) => cell(r.salary) },
  { label: 'tech_stack', value: (r) => cell(r.tech_stack) },
  { label: 'description', value: (r) => cell(r.description) },
  // Filled by the deepen step (scope B), alongside description/company.
  { label: 'company_website', value: (r) => cell(r.company_website) },
  { label: 'apply_url', value: (r) => cell(r.apply_url) },
  { label: 'ats', value: (r) => cell(r.ats) },
  { label: 'contact_name', value: (r) => cell(r.contact_name) },
  { label: 'contact_email', value: (r) => cell(r.contact_email) },
  { label: 'contact_phone', value: (r) => cell(r.contact_phone) },
  { label: 'status', value: (r) => cell(r.status) },
  // Shared team lead base (decision log): who first parsed this lead, always populated.
  { label: 'owner', value: (r) => cell(r.owner_display_name || r.owner_email) },
  { label: 'scraped_at (Kyiv)', value: (r) => formatKyivDateTime(r.scraped_at) },
  { label: 'created_at (Kyiv)', value: (r) => formatKyivDateTime(r.created_at) },
];

@Injectable()
export class SheetsDestination implements Destination {
  private readonly logger = new Logger(SheetsDestination.name);
  private sheetsClient: sheets_v4.Sheets | null = null;
  private sheetTabEnsured = false;
  private headerEnsured = false;

  private get spreadsheetId(): string {
    const id = process.env.SHEET_ID;
    if (!id) throw new Error('SHEET_ID is not set');
    return id;
  }

  // 30.08 follow-up (27.08 call): the dashboard has fully replaced the Sheet as how the team
  // views leads — Oleksandr's own words, "можеш поки відключити, буде потреба — включити" (turn
  // it off for now, turn it back on if it's needed) — so this is a reversible toggle, not a
  // rip-out; every method below (including resyncAll, the maintenance script's own operation —
  // see its own comment) is untouched and still fully functional once this is flipped back.
  // Defaults to DISABLED: requires an explicit "true" to turn on, so simply not setting this var
  // in a normal .env (the common case, and what .env.example now documents) already means off —
  // there's no separate "off" value anyone has to remember to set.
  private get sheetsSyncEnabled(): boolean {
    return process.env.GOOGLE_SHEETS_SYNC_ENABLED === 'true';
  }

  async save(record: JobLeadRecord): Promise<SaveResult> {
    if (!this.sheetsSyncEnabled) {
      // Returns before getClient()/ensureSheetTab()/etc. are ever called — no credential load,
      // no API request, no retry. 'created' is an arbitrary-but-harmless status: every caller of
      // Destination.save() only branches on status === 'failed' vs. anything else (see
      // leads.service.ts/company-linkedin.service.ts), never on created-vs-updated specifically,
      // so this can never be mistaken for a real Sheets failure — the debug log below, not the
      // return value, is the actual "this was skipped" signal (NFR-12/13: no *silent* failures —
      // this isn't a failure at all, but it still shouldn't be invisible).
      this.logger.debug(`Sheets sync disabled (GOOGLE_SHEETS_SYNC_ENABLED is not "true") — skipped for ${record.source_url}`);
      return { status: 'created' };
    }

    try {
      const sheets = await this.getClient();
      await this.ensureSheetTab(sheets);
      await this.ensureHeader(sheets);

      const existingRow = await this.findRow(sheets, record);
      const row = COLUMNS.map((col) => col.value(record));

      if (existingRow) {
        await sheets.spreadsheets.values.update({
          spreadsheetId: this.spreadsheetId,
          range: `${SHEET_NAME}!A${existingRow}:${this.lastColumn()}${existingRow}`,
          valueInputOption: 'RAW',
          requestBody: { values: [row] },
        });
        return { status: 'updated', externalRef: `${SHEET_NAME}!A${existingRow}` };
      }

      const appendRes = await sheets.spreadsheets.values.append({
        spreadsheetId: this.spreadsheetId,
        range: `${SHEET_NAME}!A:A`,
        valueInputOption: 'RAW',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values: [row] },
      });
      return { status: 'created', externalRef: appendRes.data.updates?.updatedRange ?? undefined };
    } catch (err) {
      this.logger.error(`Sheets save failed for ${record.source_url}`, err as Error);
      return {
        status: 'failed',
        error: { code: 'SHEETS_ERROR', message: err instanceof Error ? err.message : String(err) },
      };
    }
  }

  // Maintenance operation (not part of the Destination interface): clears the tab entirely
  // and rewrites every row fresh from `records`, in exactly the COLUMNS order used by save().
  // Recovers from rows written under an older column layout (see resync-sheet script) —
  // ensureHeader() alone only ever fixes row 1, never the stale data rows beneath it.
  async resyncAll(records: JobLeadRecord[]): Promise<void> {
    const sheets = await this.getClient();
    await this.ensureSheetTab(sheets);
    await sheets.spreadsheets.values.clear({ spreadsheetId: this.spreadsheetId, range: SHEET_NAME });

    const header = COLUMNS.map((col) => col.label);
    const rows = records.map((record) => COLUMNS.map((col) => col.value(record)));
    await sheets.spreadsheets.values.update({
      spreadsheetId: this.spreadsheetId,
      range: `${SHEET_NAME}!A1`,
      valueInputOption: 'RAW',
      requestBody: { values: [header, ...rows] },
    });
    this.headerEnsured = true;
    this.logger.log(`Resynced ${records.length} leads to the Sheet.`);
  }

  private async getClient(): Promise<sheets_v4.Sheets> {
    if (this.sheetsClient) return this.sheetsClient;
    const keyPath = process.env.GOOGLE_SA_KEY_PATH;
    if (!keyPath) throw new Error('GOOGLE_SA_KEY_PATH is not set');
    const keyFile = JSON.parse(fs.readFileSync(keyPath, 'utf-8'));
    const auth = new google.auth.JWT({
      email: keyFile.client_email,
      key: keyFile.private_key,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    this.sheetsClient = google.sheets({ version: 'v4', auth });
    return this.sheetsClient;
  }

  // A fresh spreadsheet only has the default "Sheet1" tab; create "Leads" if it's missing.
  private async ensureSheetTab(sheets: sheets_v4.Sheets) {
    if (this.sheetTabEnsured) return;
    const meta = await sheets.spreadsheets.get({ spreadsheetId: this.spreadsheetId });
    const exists = meta.data.sheets?.some((s) => s.properties?.title === SHEET_NAME);
    if (!exists) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: this.spreadsheetId,
        requestBody: { requests: [{ addSheet: { properties: { title: SHEET_NAME } } }] },
      });
    }
    this.sheetTabEnsured = true;
  }

  // Re-writes row 1 whenever it doesn't already match COLUMNS, so a sheet from before the
  // owner/Kyiv-time columns were added gets upgraded in place instead of drifting out of sync.
  private async ensureHeader(sheets: sheets_v4.Sheets) {
    if (this.headerEnsured) return;
    const expected = COLUMNS.map((col) => col.label);
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: this.spreadsheetId,
      range: `${SHEET_NAME}!A1:${this.lastColumn()}1`,
    });
    const current = res.data.values?.[0] ?? [];
    const matches = current.length === expected.length && expected.every((label, i) => current[i] === label);
    if (!matches) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: this.spreadsheetId,
        range: `${SHEET_NAME}!A1`,
        valueInputOption: 'RAW',
        requestBody: { values: [expected] },
      });
    }
    this.headerEnsured = true;
  }

  // external_job_id is column B, source_url is column E (see COLUMNS order above).
  private async findRow(sheets: sheets_v4.Sheets, record: JobLeadRecord): Promise<number | null> {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: this.spreadsheetId,
      range: `${SHEET_NAME}!A2:E`,
    });
    const rows = res.data.values ?? [];
    for (let i = 0; i < rows.length; i++) {
      const [, externalJobId, , , sourceUrl] = rows[i];
      if (externalJobId === record.external_job_id || sourceUrl === record.source_url) {
        return i + 2; // +2: 1-indexed sheet rows, plus the header row
      }
    }
    return null;
  }

  private lastColumn(): string {
    return String.fromCharCode('A'.charCodeAt(0) + COLUMNS.length - 1);
  }
}
