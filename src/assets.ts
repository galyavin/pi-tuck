// Everything semantic recall's local runtime is built from: a public source and its SHA-256 for each file. setup.ts downloads and
// verifies these, and a change to any of them gives the runtime a new id, so an update provisions beside the old runtime, never over it.

import { createHash } from "node:crypto";
import { join } from "node:path";

export interface Download { url: string; sha256: string; size: number }

/** A relocatable CPython for macOS arm64; the runtime's virtual environment is made from it and keeps pointing at it. */
export const PYTHON: Download & { version: string; name: string } = {
	name: "cpython-3.13.18+20261026", version: "3.13", size: 25394044,
	url: "https://github.com/astral-sh/python-build-standalone/releases/download/20261026/cpython-3.13.18%2B20261026-aarch64-apple-darwin-install_only.tar.gz",
	sha256: "e5af2fde6a937a0e0c795a0c595c4efb70578d57463a2657c819992b9b9acbac",
};

/** EmbeddingGemma-2, 8-bit GGUF. */
export const MODEL: Download = {
	url: "https://huggingface.co/unsloth/embeddinggemma-2-GGUF/resolve/031f0d4b35536f69ab3509d4893c923264fcf253/embeddinggemma-2-Q8_0.gguf",
	sha256: "6f1bd4ac6c5df7444f9cca7ca36cafe6cfa34cd6f49fefb1e0b4be8143aed8bc", size: 309855520,
};

/** The model's own tokenizer: passages are split on its token offsets. */
export const TOKENIZER: Download = {
	url: "https://huggingface.co/google/embeddinggemma-2/resolve/914f7f89142e33e77833254d9c9b90c3cef7303b/tokenizer.json",
	sha256: "4d777ef5bdc1aa36227abdfb77c3e49e7b9c892d16e1b6bda41c393504828be4", size: 32170510,
};

/** llama.cpp release b11476 (commit 988190680d5a). `files` are the server and the libraries it loads from its own folder; the archive
 * names most libraries through symlinks, which the runtime refuses, so each is copied as a plain file under the name the server loads. */
export const LLAMA: Download & { folder: string; files: Record<string, string>; license: string } = {
	url: "https://github.com/ggml-org/llama.cpp/releases/download/b11476/llama-b11476-bin-macos-arm64.tar.gz",
	sha256: "577634a1b8a59e8dabe02ba10de1e610be0574dfaf1cf3020e6dd42853ed877e", size: 12012019,
	folder: "llama-b11476",
	files: {
		"llama-server": "1bf5602a2be50097c44282a6ecc63234d94ee8f96d39fd45fed6eff4e74b6b41",
		"libllama-server-impl.dylib": "d699e1d7f0b3d5c63c9e7cd88c50e37c96cbf64802dbcefdc784983565a29608",
		"libllama-common.0.dylib": "e90e6f5bba4ff114f7fb9ed1328171b1c4eceac71ee8923178f5d417310b0d4e",
		"libmtmd.0.dylib": "c87488222bc71275f75da743e8cc628b014b59d051bc0e303c444e96f54762a7",
		"libllama.0.dylib": "423bd595e045f0bb8225ad721571d5ab9842815f1b975f2462d2c7c8e0594bd7",
		"libggml.0.dylib": "85ac40d540a5cc86f28a70270ddcdde677e92eb585c3bacd1b7e82270fe8934b",
		"libggml-cpu.0.dylib": "937073375f79a187d8fda2e3900a9095e979593b691d6bbb146956743ceddd82",
		"libggml-blas.0.dylib": "6526259e8f70a5b3a394df3ba082050c290d7653846efbdc84b3710b22fb4eac",
		"libggml-metal.0.dylib": "a40058fab152c973339e40e80df900c1b311e06bcfb4c1c473cb169c7ee88a5c",
		"libggml-rpc.0.dylib": "48c13b7c2c56e2b569b636e6a28d1c0853ad2d1db1980c0afd374651c6e897d0",
		"libggml-base.0.dylib": "6fba8bb7fb529801d1b73782ac1707b653b1ea4caf53f667b85bc801e2883326",
	},
	license: "94f29bbed6a22c35b992c5c6ebf0e7c92f13b836b90f36f461c9cf2f0f1d010d",
};

const pypi = (path: string, sha256: string, size: number): Download => ({ url: "https://files.pythonhosted.org/packages/" + path, sha256, size });
/** The tokenizer library and its declared dependencies, installed offline with hash checking. */
export const WHEELS: Record<string, Download> = {
	"anyio-4.15.1-py3-none-any.whl": pypi("12/b8/4bd346e22b28902df4d651910f5242c28d84e4a5c2435ca5c3f797ed7e2e/anyio-4.15.1-py3-none-any.whl", "6152fdbbf9a77fdec97731721bebf7c4c44f7c29b424b0065826173efc7ed101", 132079),
	"certifi-2026.7.22-py3-none-any.whl": pypi("0b/a7/71ac2cff56fec219ed242bb11b8efb69fcc4bec75db06fb7bfe35de520e6/certifi-2026.7.22-py3-none-any.whl", "62f22742b58a1a33014a2b6b706588a8d7e2a88ae7bd1a6ebe8c992928483775", 136983),
	"click-8.5.0-py3-none-any.whl": pypi("58/50/6c0d534c5f134586a8e1ba4e330569e32f057e33372ae556463212fb4cd3/click-8.5.0-py3-none-any.whl", "255bc9599cf7748b4b1a446ccc735421bd08a2ae529a8b88597d3de5664ee360", 125251),
	"filelock-4.0.12-py3-none-any.whl": pypi("da/a1/b047e1c486a2c66283633b7dbb73872ca16ca1ce6a426f70d4d037fc8e1c/filelock-4.0.12-py3-none-any.whl", "5f17ee83ecee8a6f3e389c75822fb70a1c2f0506b99438a6dffa1d56793588c8", 111732),
	"fsspec-2026.9.0-py3-none-any.whl": pypi("6c/c0/a98505f18594f1bce828bb159cec0fcf9860562f1a2c85913409fc8f3d9e/fsspec-2026.9.0-py3-none-any.whl", "8dd6e646e99ea382bd85f97a45e6b526a442d79423a7dc673f1e2756d05fcb5f", 221738),
	"h11-0.16.0-py3-none-any.whl": pypi("04/4b/29cac41a4d98d144bf5f6d33995617b185d14b22401f75ca86f384e87ff1/h11-0.16.0-py3-none-any.whl", "63cf8bbe7522de3bf65932fda1d9c2772064ffb3dae62d55932da54b31cb6c86", 37515),
	"hf_xet-1.7.0-cp38-abi3-macosx_11_0_arm64.whl": pypi("c3/47/a26ebdce7056a61e931f228439bc0ab08cbec239d1690f965e5e637cba79/hf_xet-1.7.0-cp38-abi3-macosx_11_0_arm64.whl", "59fba37039233c7fcbe196817d6cdcf1b40dfb17b410f229d85b0cf0a1848da4", 3560352),
	"httpcore-1.0.9-py3-none-any.whl": pypi("7e/f5/f66802a942d491edb555dd61e3a9961140fd64c90bce1eafd741609d334d/httpcore-1.0.9-py3-none-any.whl", "2d400746a40668fc9dec9810239072b40b4484b640a8c38fd654a024c7a1bf55", 78784),
	"httpx-0.28.1-py3-none-any.whl": pypi("2a/39/e50c7c3a983047577ee07d2a9e53faf5a69493943ec3f6a384bdc792deb2/httpx-0.28.1-py3-none-any.whl", "d909fcccc110f8c7faf814ca82a9a4d816bc5a6dbfea25d6591d6985b8ba59ad", 73517),
	"huggingface_hub-1.33.0-py3-none-any.whl": pypi("fc/16/963096d224b80909432dc16561a615fd33d2d13beef3ce4c63fa25e40867/huggingface_hub-1.33.0-py3-none-any.whl", "04e434b06e100eddbce9a6e817d72693a7884b10a79bd67ab48080d5c07eb899", 846435),
	"idna-3.20-py3-none-any.whl": pypi("58/a2/bb081bab032533a855d44de1d56f8e8426114ff1ba5d1f07a438a0a654f8/idna-3.20-py3-none-any.whl", "ab7ae7122974553370f0bdb919e1a960b2cd1bc1ef0276416d896db81c14582c", 69583),
	"packaging-26.3-py3-none-any.whl": pypi("63/34/ba1c580383c9eada3711951fef0795c80b829a078d72188184bcab9dd527/packaging-26.3-py3-none-any.whl", "d7193f7c8e4e93f444fde0262bf90af30e16fa0ad0ad44cb553c87339b23cd1c", 129956),
	"pyyaml-6.0.3-cp313-cp313-macosx_11_0_arm64.whl": pypi("b1/16/95309993f1d3748cd644e02e38b75d50cbc0d9561d21f390a76242ce073f/pyyaml-6.0.3-cp313-cp313-macosx_11_0_arm64.whl", "2283a07e2c21a2aa78d9c4442724ec1eb15f5e42a723b99cb3d822d48f5f7ad1", 173252),
	"tokenizers-0.23.2-cp310-abi3-macosx_11_0_arm64.whl": pypi("67/49/22da045a91732384d3a3771816bf188dc5a1f702c32e635afa7c679c0bef/tokenizers-0.23.2-cp310-abi3-macosx_11_0_arm64.whl", "986670e43691469dcee610ea0f846f91a8f84e91fc6f7a48d4c064414c0ec2bf", 3101593),
	"tqdm-4.70.1-py3-none-any.whl": pypi("a7/03/921a3d3c75785aca9ebfbfcabfbc3a1be12e2ab5265deb026d55a5a3f83e/tqdm-4.70.1-py3-none-any.whl", "c293e525e6fef9c20e8728fd4612df02a0aa31bb5fe91ecd93e123b1b7bffa73", 80199),
	"typing_extensions-4.16.0-py3-none-any.whl": pypi("49/d3/b8441a820a491ddfc024b0b0cf0393375b75ea13866d9c66727e54c2fc80/typing_extensions-4.16.0-py3-none-any.whl", "481caa481374e813c1b176ada14e97f1f67a4539ce9cfeb3f350d78d6370c2e8", 45571),
};

export const REQUIREMENTS = [
	"PyYAML==6.0.3", "anyio==4.15.1", "certifi==2026.7.22", "click==8.5.0", "filelock==4.0.12", "fsspec==2026.9.0", "h11==0.16.0",
	"hf-xet==1.7.0", "httpcore==1.0.9", "httpx==0.28.1", "huggingface_hub==1.33.0", "idna==3.20", "packaging==26.3", "tokenizers==0.23.2",
	"tqdm==4.70.1", "typing_extensions==4.16.0",
];

/** What scripts/eg2-runtime.py checks the runtime against: the model, its encoding contract and the native build. */
export const PINS = {
	embedding: { model: "google/embeddinggemma-2", revision: "914f7f89142e33e77833254d9c9b90c3cef7303b", dimensions: 768, maxTokens: 8192,
		queryInstruction: "task: search result | query: ", documentInstruction: "title: none | text: ",
		pooling: "mask-aware mean including prompt, projected token states, then float32 L2", dtype: "Q8_0", textOnly: true },
	runtime: { tokenizers: "0.23.2", python: PYTHON.version },
	backend: { name: "llama.cpp", commit: "988190680d5a89fce97de3c20df2c2813731fd61", artifact: "Q8_0", computePrecision: "float32", gpuLayers: 0,
		compute: "CPU float32 with f32 KV; quantized weights where selected", modelRepository: "unsloth/embeddinggemma-2-GGUF",
		modelRevision: "031f0d4b35536f69ab3509d4893c923264fcf253", modelSHA256: MODEL.sha256 },
};

/** A digest of every pinned input: a changed pin provisions a new runtime beside the old one instead of mutating it. */
export const RUNTIME_ID = createHash("sha256").update(JSON.stringify({ PYTHON, MODEL, TOKENIZER, LLAMA, WHEELS, REQUIREMENTS, PINS })).digest("hex").slice(0, 16);
/** The provisioned runtime's configuration, written last by provisioning: its presence means the runtime is complete. */
export const runtimeConfigPath = (root: string) => join(root, "runtime", RUNTIME_ID, "semantic-recall.json");
