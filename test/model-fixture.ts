import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { vi } from "vitest";

export async function scriptedModelRuntime() {
 const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
 const model = runtime.getModel("openai-codex", "gpt-6.1-sol");
 if (!model) throw new Error("Required catalogue model unavailable");
 // Only scripted stream functions consume this admission; no provider transport/auth runs.
 vi.spyOn(runtime, "hasConfiguredAuth").mockImplementation(provider => provider === model.provider);
 vi.spyOn(runtime, "getAuth").mockResolvedValue({ auth: { headers: { "x-scripted-fixture": "1" } }, source: "scripted test" });
 vi.spyOn(runtime, "getAvailable").mockResolvedValue([model]);
 vi.spyOn(runtime, "getAvailableSnapshot").mockReturnValue([model]);
 return runtime;
}
