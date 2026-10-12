import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { relative } from 'node:path';

const summary = JSON.parse(readFileSync('coverage/coverage-summary.json', 'utf8'));
const rows = ['## Code coverage', '', '| File | Lines | Branches | Functions |', '| --- | ---: | ---: | ---: |'];
for (const [file, metrics] of Object.entries(summary)) {
  const name = file === 'total' ? '**Total**' : `\`${relative(process.cwd(), file).replaceAll('\\', '/')}\``;
  rows.push(`| ${name} | ${metrics.lines.pct}% | ${metrics.branches.pct}% | ${metrics.functions.pct}% |`);
}

rows.push('', '### Uncovered lines', '');
let uncovered = false;
for (const record of readFileSync('coverage/lcov.info', 'utf8').split('end_of_record')) {
  const file = record.match(/^SF:(.+)$/m)?.[1]?.trim();
  const lines = [...record.matchAll(/^DA:(\d+),0(?:,.*)?$/gm)].map((match) => Number(match[1]));
  if (file && lines.length) {
    uncovered = true;
    rows.push(`- \`${file.replaceAll('\\', '/')}\`: ${lines.join(', ')}`);
  }
}
if (!uncovered) rows.push('All instrumented lines are covered.');
rows.push('', 'Download the coverage-report artifact for the HTML, LCOV and Cobertura reports.', '');
const markdown = rows.join('\n');
writeFileSync('coverage/summary.md', markdown);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
console.log(markdown);
