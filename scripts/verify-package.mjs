#!/usr/bin/env node
import { readFile, writeFile, mkdir, rm } from 'fs/promises';
import { exec } from 'child_process';
import { promisify } from 'util';
import { join } from 'path';
import { tmpdir } from 'os';

const execAsync = promisify(exec);

async function verifyPackage() {
  console.log('Step 1: Building package...');
  await execAsync('npm run build');
  
  console.log('\nStep 2: Packing tarball...');
  const { stdout: packOut } = await execAsync('npm pack --dry-run');
  console.log(packOut);
  
  // Check for @ imports in dist
  console.log('\nStep 3: Checking for @/ imports in dist...');
  try {
    const { stdout: grepOut } = await execAsync('grep -r "from [\"\\x27]@/" dist/ || true');
    if (grepOut.trim()) {
      console.error('ERROR: Found @/ imports in dist:');
      console.error(grepOut);
      process.exit(1);
    }
    
    const { stdout: grepOut2 } = await execAsync('grep -r "require([\"\\x27]@/" dist/ || true');
    if (grepOut2.trim()) {
      console.error('ERROR: Found @/ require in dist:');
      console.error(grepOut2);
      process.exit(1);
    }
    
    console.log('✓ No @/ imports found in dist');
  } catch (err) {
    console.error('Error checking for @/ imports:', err.message);
    process.exit(1);
  }
  
  // Check that test files are excluded
  console.log('\nStep 4: Checking test files are excluded...');
  try {
    const { stdout: testFiles } = await execAsync('find dist/test -name "*.js" 2>/dev/null || true');
    if (testFiles.trim()) {
      console.error('ERROR: Found test files in dist:');
      console.error(testFiles);
      process.exit(1);
    }
    console.log('✓ No test files in dist');
  } catch (err) {
    // Expected if dist/test doesn't exist
    console.log('✓ No test files in dist');
  }
  
  // Create actual tarball
  console.log('\nStep 5: Creating tarball...');
  const { stdout: packOutput } = await execAsync('npm pack');
  const tarballName = packOutput.trim().split('\n').pop();
  console.log(`Created: ${tarballName}`);
  
  // Test install in temp directory
  const testDir = join(tmpdir(), `coralswap-test-${Date.now()}`);
  await mkdir(testDir, { recursive: true });
  
  try {
    console.log(`\nStep 6: Testing tarball in ${testDir}...`);
    
    // Create a minimal package.json
    await writeFile(
      join(testDir, 'package.json'),
      JSON.stringify({
        name: 'test-consumer',
        version: '1.0.0',
        type: 'module'
      }, null, 2)
    );
    
    // Install the tarball
    const tarballPath = join(process.cwd(), tarballName);
    await execAsync(`npm install ${tarballPath}`, { cwd: testDir });
    console.log('✓ Tarball installed successfully');
    
    // Create test file with node16 moduleResolution
    await writeFile(
      join(testDir, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          moduleResolution: 'node16',
          module: 'node16',
          target: 'ES2022',
          strict: true,
          esModuleInterop: true,
          skipLibCheck: true
        }
      }, null, 2)
    );
    
    // Create a test consumer file
    await writeFile(
      join(testDir, 'test.js'),
      `import { CoralSwapClient } from '@coralswap/sdk';
console.log('✓ Import successful');
console.log('CoralSwapClient:', typeof CoralSwapClient);
`
    );
    
    // Try to run it
    console.log('\nStep 7: Testing import...');
    const { stdout: runOut } = await execAsync('node test.js', { cwd: testDir });
    console.log(runOut);
    
    console.log('\n✅ All checks passed!');
    
  } finally {
    // Cleanup
    await rm(testDir, { recursive: true, force: true });
    console.log(`\nCleaned up ${testDir}`);
  }
}

verifyPackage().catch(err => {
  console.error('Verification failed:', err);
  process.exit(1);
});
