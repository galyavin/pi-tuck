# Contributing

Thanks for helping with pi-tuck.

## Run the tests

```bash
npm ci
npm run build   # refresh src/build-id.ts after source changes
npm run check   # type-check
npm test        # test suite
```

Run the slower stress suite with CI's strict failure checks using `STRESS=1 STRESS_STRICT=1 npm test -- test/stress --testTimeout=600000`. CI runs these checks on the minimum supported Pi release and the latest published one.

## Pull requests

- Keep a pull request to one change, with a test that covers it.
- Make sure `npm run check` and `npm test` pass.
- Describe what changes and how you tested it; the template asks for both.

## Reporting a bug

Open an issue with the bug report form. It asks for the Pi version, the pi-tuck version, your operating system, the steps and the error.

To inspect an incident from a checkout, build the package and run `node scripts/incident.mjs replay incident.jsonl report.json`. Use the same build that recorded it for deterministic replay. Choose `export` in place of `replay` for a readable text report. Both commands require a new output path.
