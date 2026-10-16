import * as fs from 'fs';
import * as path from 'path';
import { generateMarkdown } from '../scripts/generate-error-doc';

describe('Error Taxonomy Documentation', () => {
  it('should be up to date with the ERROR_TAXONOMY table in src/errors.ts', () => {
    const docPath = path.join(__dirname, '../docs/error-taxonomy.md');
    
    // Check if the documentation file exists
    if (!fs.existsSync(docPath)) {
      throw new Error(
        `Error taxonomy documentation is missing at docs/error-taxonomy.md.\n` +
        `Please run 'npm run docs:errors' to generate it.`
      );
    }
    
    const existingMarkdown = fs.readFileSync(docPath, 'utf-8');
    const expectedMarkdown = generateMarkdown();
    
    if (existingMarkdown !== expectedMarkdown) {
      throw new Error(
        `Error taxonomy documentation is out of date.\n` +
        `Please run 'npm run docs:errors' to update docs/error-taxonomy.md.`
      );
    }
    
    expect(existingMarkdown).toBe(expectedMarkdown);
  });
});
