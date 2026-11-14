/** Stable request bytes across runs: replace directory spellings before JSON can escape backslashes.
 * All other string contents and fields stay exact, apart from transport-ignored timing metadata. */
export function requestBytes(context: unknown, directory: string): string {
 const spellings = [...new Set([directory, directory.replace(/\\/g, '/')])];
 return JSON.stringify(context, (key, value) => key === 'timestamp' || key === 'durationMs' ? undefined :
  typeof value === 'string' ? spellings.reduce((text, path) => text.replaceAll(path, '<session>'), value) : value);
}
