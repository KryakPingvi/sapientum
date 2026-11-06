# CI

GitHub Actions runs on pull requests, pushes to `main`, and manual dispatches.
It uses Node.js 22.19.0, installs the locked dependencies with `npm ci` and starts a
PostgreSQL 16 service for the tests. `DATABASE_URL` points the tests at it.

Run the same checks locally:

```sh
docker compose -f infra/compose.yaml up -d
npm ci
npm run format:check
npm run typecheck
npm run build
npm run test:coverage
npm run coverage:summary
```

Use `npm run format` to fix formatting. Formatting uses Prettier and includes
source code, tests, configuration, documentation, and workflows.

Coverage includes the API and contracts, including unexecuted implementation
files, and maps compiled JavaScript back to TypeScript. Tests and generated
declarations are excluded, as is `ports.ts`, which contains only TypeScript
interfaces and has no executable code. No minimum coverage threshold is enforced.

The job summary lists coverage by file and uncovered line numbers. The
`coverage-report` artifact contains HTML, LCOV, Cobertura, and JSON reports and
is retained for 14 days. Open `coverage/index.html` for the detailed local report.

For pull requests from this repository, the workflow updates a single coverage
comment. Fork and Dependabot pull requests still run checks and upload reports;
they skip commenting because their tokens cannot write PR comments.
