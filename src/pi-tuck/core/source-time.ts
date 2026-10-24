/** Recorded source time only; never event occurrence, retrieval time or ordering. */
export type SourceTime = { basis: "message" | "journal"; utc: string } | { basis: "unknown" };
const utc = (value: unknown): string | undefined => {
 if (typeof value !== "number" && typeof value !== "string") return;
 if (typeof value === "number" && (!Number.isSafeInteger(value) || value < 0)) return;
 if (typeof value === "string" && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) return;
 const time = new Date(value); if (!Number.isFinite(time.getTime())) return;
 const iso = time.toISOString(); if (!/^\d{4}-/.test(iso)) return;
 if (typeof value === "string" && value.slice(0, 19) !== iso.slice(0, 19)) return;
 return iso.replace(/\.000Z$/, "Z");
};
export function resolveSourceTime(source: { timestamp?: unknown; type?: string; message?: { timestamp?: unknown } }): SourceTime {
 const message = source.type === "message" ? utc(source.message?.timestamp) : undefined;
 if (message) return { basis: "message", utc: message };
 const journal = utc(source.timestamp);
 return journal ? { basis: "journal", utc: journal } : { basis: "unknown" };
}
export function validSourceTime(value: unknown): value is SourceTime {
 if (!value || typeof value !== "object" || Array.isArray(value)) return false;
 const v = value as SourceTime;
 return v.basis === "unknown" ? Object.keys(v).length === 1 :
  ["message", "journal"].includes(v.basis) && Object.keys(v).length === 2 && "utc" in v && utc(v.utc) === v.utc;
}
