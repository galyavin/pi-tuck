import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { vi } from "vitest";

export async function scriptedModelRuntime() {
 const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
 const catalogued = runtime.getModel("openai-codex", "gpt-6.1-sol");
 if (!catalogued) throw new Error("Required catalogue model unavailable");
 // The tests' budgets are worked out for a 272,000-token window with 128,000 output tokens, this model's limits in Pi 1.1.0's catalogue.
 // Later catalogues changed the window, so the fixture pins both rather than following the installed catalogue.
 const model = { ...catalogued, contextWindow: 272000, maxTokens: 128000 }, getModel = runtime.getModel.bind(runtime);
 vi.spyOn(runtime, "getModel").mockImplementation((provider, id) => provider === model.provider && id === model.id ? model : getModel(provider, id));
 // Only scripted stream functions consume this admission; no provider transport/auth runs.
 vi.spyOn(runtime, "hasConfiguredAuth").mockImplementation(provider => provider === model.provider);
 vi.spyOn(runtime, "getAuth").mockResolvedValue({ auth: { headers: { "x-scripted-fixture": "1" } }, source: "scripted test" });
 vi.spyOn(runtime, "getAvailable").mockResolvedValue([model]);
 vi.spyOn(runtime, "getAvailableSnapshot").mockReturnValue([model]);
 return runtime;
}
