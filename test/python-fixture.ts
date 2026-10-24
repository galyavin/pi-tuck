import { execFileSync } from "node:child_process";
import { isAbsolute } from "node:path";

const helper = process.env.AB1_EG2_TEST_NATIVE_HELPER;
if (process.platform === "win32" && (!helper || !isAbsolute(helper))) throw new Error("Windows compactor tests require AB1_EG2_TEST_NATIVE_HELPER with an absolute path to the supplied native owner helper.");
export const testNativeOwner = process.platform === "win32" ? { nativeOwnerHelperPath: helper! } : {};
/** Every test that runs the interpreter itself passes these first: -B keeps it from writing bytecode into the interpreter's own tree (the managed install is verified file by file; -I ignores PYTHONDONTWRITEBYTECODE). */
export const pythonFlags = ["-I", "-B"] as const;
export const testPython = execFileSync(process.env.AB1_EG2_TEST_PYTHON ?? process.env.AB1_TEST_PYTHON ?? (process.platform === "win32" ? "python.exe" : "python3"), [...pythonFlags, "-c", "import sys;print(sys.executable)"], { encoding: "utf8" }).trim();
