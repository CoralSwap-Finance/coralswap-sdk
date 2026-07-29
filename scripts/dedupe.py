from pathlib import Path
p = Path('src/modules/swap.ts')
lines = p.read_text().splitlines(True)
out, prev = [], None
for l in lines:
    if l == prev and 'schemas/swap' in l:
      continue
    out.append(l)
    prev = l
p.write_text(''.join(out))
print('deduped/o')
