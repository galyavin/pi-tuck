# Pi request admission and recovery

Pi-tuck can plan a smaller transcript using Pi's extension hooks. It needs Pi to authorize execution. On current Pi, `before_provider_request` is an ordered payload transformation. A later handler can replace the payload, and the extension runner reports handler exceptions and continues. The Chat Completions provider also builds the payload once before entering its transport retry loop. Moving pi-tuck later in the extension order cannot establish an admission boundary.

## Proposed Pi interface

Expose a supported preflight estimate of the prepared transcript for cheap planning. Report the proposed generation cap alongside the estimated input. Pi-tuck uses those values to choose context changes and can retire its compatibility lookup for Pi's estimator and clamp.

At execution, Pi supplies its provider adapter with the active attempt and its cancellation signal. After extension transformations, the adapter assesses and sends the same request. Where the backend supports admission, use its rendered input, effective window and generation limits on that send. The adapter reports confirmed capacity rejection when the backend identifies it. A preflight estimate or an ambiguous length stop carries no such authority. When a server configuration can change between assessment and use, the server must validate at admission; a separate client token count alone cannot provide this guarantee.

Pi owns the attempt allowance. A new automatic send, including a transport retry or provider continuation, consumes permission from Pi before dispatch. A transient transport failure may retry the same request within that allowance. A capacity recovery improves the constraint that failed. Check rendered input for an input limit and rendered input plus the requested output for a combined limit. For ambiguous token overflow, require both quantities to decrease. A retry after output exhaustion needs more usable generation room. Pi requests a context revision through its existing compaction or boundary hooks, commits the accepted revision, and can then permit another attempt. A native continuation also needs the adapter's confirmation that the backend resumed the intended state. Tool execution still requires a completed tool call.

Preserve the unfinished response when an attempt ends. If mandatory input cannot fit or recovery runs out, return that outcome to the existing settlement path. Where authoritative input admission is unavailable, report capacity as estimated or unknown and keep recovery bounded. Any exact capacity claim is scoped to the backend configuration that supplied it.

Return usage tied to the same final request so pi-tuck can calibrate across resumes. Scope the observation to the serving route. Once this evidence is available, persist only matched observations, keep ambiguous rejection evidence with its failed attempt, and start older unlabelled calibration windows at neutral.

## Contract checks

- A later extension replaces the request. The sender assesses that replacement and honors rejection before any generation or tool execution.
- A transport retry and session retry occur in one run. Both use the same allowance and cancellation signal, and neither sends after terminal settlement.
- A session write fails during a recovery revision. No request depending on that revision is sent.
- A backend rejects actual capacity, reports ordinary output exhaustion, or supplies only a length stop. Each outcome retains its distinct evidence and selects only permitted recovery.
- A provider without authoritative counting still runs normal requests and compaction. Another provider changes its effective window or route between attempts. Earlier measurements do not authorize the new request.
