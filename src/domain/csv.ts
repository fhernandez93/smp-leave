/** CSV export, byte-compatible with v1: UTF-8 BOM, CRLF, quotes around fields with `" , ; \n`. */

export function csvEscape(v: unknown): string {
  const s = String(v == null ? "" : v);
  return /[",\n;\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCSV(rows: readonly (readonly unknown[])[]): string {
  return "﻿" + rows.map((r) => r.map(csvEscape).join(",")).join("\r\n");
}

export function csvFilename(teamName: string, year: number): string {
  return `leave-${(teamName || "team").replace(/\W+/g, "-").toLowerCase()}-${year}.csv`;
}
