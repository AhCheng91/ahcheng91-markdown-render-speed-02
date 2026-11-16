import { parse } from './parse.js';

const inDir = process.env.MAKEFUN_INPUT_DIR || '/input';
const outDir = process.env.MAKEFUN_OUTPUT_DIR || '/output';
const fs = await import('node:fs');
const path = await import('node:path');

const cases = JSON.parse(fs.readFileSync(path.join(inDir, 'cases.json'), 'utf8'));
const htmls = new Array(cases.length);
for (let i = 0; i < cases.length; i++) {
  htmls[i] = parse(cases[i].markdown);
}
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'html.json'), JSON.stringify(htmls));
