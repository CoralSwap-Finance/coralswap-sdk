import * as fs from 'fs';
import * as path from 'path';
import { ERROR_TAXONOMY } from '../src/errors';

const DOCS_DIR = path.join(__dirname, '../docs');
const DOC_FILE_PATH = path.join(DOCS_DIR, 'error-taxonomy.md');

function generateMarkdown(): string {
  let md = `# Error Taxonomy\n\n`;
  md += `This document maps CoralSwap SDK error classes to their string codes and recommended retry policies.\n\n`;
  md += `> **Note**: This file is auto-generated from \`src/errors.ts\`. Do not edit directly.\n\n`;
  
  md += `| Error Class | Error Code | Retry Policy |\n`;
  md += `|-------------|------------|--------------|\n`;

  for (const entry of ERROR_TAXONOMY) {
    md += `| \`${entry.class}\` | \`${entry.code}\` | \`${entry.retryPolicy}\` |\n`;
  }

  return md;
}

function main() {
  const md = generateMarkdown();
  
  if (!fs.existsSync(DOCS_DIR)) {
    fs.mkdirSync(DOCS_DIR, { recursive: true });
  }

  fs.writeFileSync(DOC_FILE_PATH, md, 'utf-8');
  console.log(`Successfully generated ${DOC_FILE_PATH}`);
}

if (require.main === module) {
  main();
}

export { generateMarkdown };
