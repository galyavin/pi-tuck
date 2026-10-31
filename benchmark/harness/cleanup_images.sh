#!/bin/sh
# Remove the SWE-bench task images of the given instance ids once no run needs them (each is about 3 GB).
for id in "$@"; do docker rmi "ghcr.io/epoch-research/swe-bench.eval.arm64.$id:latest" >/dev/null 2>&1; done
