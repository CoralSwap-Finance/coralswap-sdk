#!/usr/bin/env node
import { readdir, readFile, writeFile } from 'fs/promises';
import { join, relative, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const distDir = join(__dirname, '../dist');

async function rewriteImports(filePath) {
  const content = await readFile(filePath, 'utf-8');
  const fileDir = dirname(filePath);
  
  // Match both require("@/...") and from "@/..."
  const rewritten = content.replace(
    /(require\(["'])@\/(.*?)(["']\)|from ["']@\/(.*?)["'])/g,
    (match, prefix, path1, suffix, path2) => {
      const importPath = path1 || path2;
      const targetPath = join(distDir, importPath);
      let relativePath = relative(fileDir, targetPath);
      
      // Ensure relative path starts with ./
      if (!relativePath.startsWith('.')) {
        relativePath = './' + relativePath;
      }
      
      // Remove .js extension if present in original, we'll let Node resolve it
      relativePath = relativePath.replace(/\.js$/, '');
      
      if (path1) {
        return `${prefix}${relativePath}${suffix}`;
      } else {
        return `from "${relativePath}"`;
      }
    }
  );
  
  if (content !== rewritten) {
    await writeFile(filePath, rewritten, 'utf-8');
    console.log(`Rewrote imports in ${relative(distDir, filePath)}`);
  }
}

async function walkDir(dir) {
  const files = await readdir(dir, { withFileTypes: true });
  
  for (const file of files) {
    const fullPath = join(dir, file.name);
    
    if (file.isDirectory()) {
      await walkDir(fullPath);
    } else if (file.name.endsWith('.js') || file.name.endsWith('.d.ts')) {
      await rewriteImports(fullPath);
    }
  }
}

try {
  console.log('Rewriting @/ imports in dist/...');
  await walkDir(distDir);
  console.log('Done!');
} catch (err) {
  console.error('Error rewriting imports:', err);
  process.exit(1);
}
