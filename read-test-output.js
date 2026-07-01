const fs = require('fs');
try {
  const content = fs.readFileSync('test-output.txt', 'utf16le');
  console.log(content.slice(0, 1000));
} catch (err) {
  console.error(err);
}
