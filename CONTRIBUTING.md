# Contributing

Thanks for helping with pi-tuck.

## Run the tests

```bash
npm ci
npm run check   # type-check
npm run build   # refresh src/build-id.ts after source changes
npm test        # test suite
```

The stress tests are slower and run in CI: `STRESS=1 npx vitest run test/stress`.

## Pull requests

- Keep a pull request to one change, with a test that covers it.
- Make sure `npm run check` and `npm test` pass.
- Describe what changes and how you tested it; the template asks for both.

## Reporting a bug

Open an issue with the bug report form. It asks for the Pi version, the pi-tuck version, your operating system, the steps and the error.

To inspect an incident from a checkout, build the package and run `node scripts/incident.mjs replay incident.jsonl report.json`. Use the same build that recorded it for deterministic replay. Choose `export` in place of `replay` for a readable text report. Both commands require a new output path.
