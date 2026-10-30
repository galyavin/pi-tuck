export const PATH_KEYS = ["path", "file_path", "filePath", "file"] as const;

export const extractPath = (args: Record<string, unknown>): string | null => {
  for (const key of PATH_KEYS) {
    if (typeof args[key] === "string") return args[key] as string;
  }
  return null;
};
