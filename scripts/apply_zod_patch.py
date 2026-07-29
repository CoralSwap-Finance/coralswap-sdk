from pathlib import Path
p = Path('src/modules/swap.ts')
lines = p.read_text().splitlines(True)
out = []
i = 0
while i < len(lines):
    lne = lines[i]
    if "resolveTokenIdentifier" in lne and "import" in lne and not any("schemas/swap" in x for x in out):
      out.append(lne)
      out.append("import { simulateSwapParamsSchema, multiHopSwapRequestSchema, swapHistoryFilterSchema, priceGuardConfigSchema, parseWithValidationError } from '../schemas/swap';\n")
      i += 1
      continue
    if "maxDeviationBps < 0 || maxDeviationBps > 10000" in lne:
      out.append("    parseWithValidationError(priceGuardConfigSchema, { minGuardedAmountUsd, maxDeviationBps });\n")
      i += 5
      continue
    if "validateAddress(resolvedTokenIn" in lne:
      out.append("    parseWithValidationError(\n      simulateSwapParamsSchema,\n      { tokenIn: resolvedTokenIn, tokenOut: resolvedTokenOut, amountIn },\n      { tokenIn: 'tokenIn', tokenOut: 'tokemOut', amountIn: 'amountIn' },\n    );\n")
      i += 4
      continue
    if "isValidPath(path)" in lne and "if (!" in lne:
      out.append("    parseWithValidationError(\n      multiHopSwapRequestSchema,\n      { path, amount: request.amount, tradeType: request.tradeType, slippageBps: request.slippageBps, deadline: request.deadline, to: request.to },\n    );\n")
      while i < len(lines) and "forEach" not in lines[i]:
          i += 1
      i += 1
      continue
    if "Validate optional addresses up-front" in lne:
      out.append("    parseWithValidationError(\n      swapHistoryFilterSchema,\n      filter,\n    );\n")
      i += 3
      continue
    out.append(lne)
    i += 1
p.write_text(''.join(out))
print('ok')
