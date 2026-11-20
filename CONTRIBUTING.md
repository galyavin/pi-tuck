# Contributing

Thanks for helping with pi-tuck.

## Run the tests

```bash
npm ci
npm run check   # type-check
npm test        # test suite
```

The stress tests are slower and run in CI: `STRESS=1 npx vitest run test/stress`.

## Pull requests

- Keep a pull request to one change, with a test that covers it.
- Make sure `npm run check` and `npm test` pass.
- Describe what changes and how you tested it; the template asks for both.

## Reporting a bug

Open an issue with the bug report form. It asks for the Pi version, the pi-tuck version, your operating system, the steps and the error.
