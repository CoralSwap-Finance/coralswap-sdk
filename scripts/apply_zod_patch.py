from pathlib import Path
import re
p = Path('src/modules/swap.ts')
t = p.read_text()

imp = "import { resolveTokenIdentifier } from '../utils/addresses';"
nimp = imp + "\n" + "import { simulateSwapParamsSchema, multiHopSwapRequestSchema, swapHistoryFilterSchema, priceGuardConfigSchema, parseWithValidationError } from '../schemas/swap';"
if imp in t and "schemas/swap" not in t:
"p    t = t.replace(imp, nimp, 1)

t2, n = re.subn(
    r'  setPriceGuardConfig(minGuardedAmountUsd: bigint, maxDeviationBps: number): void {\n    if (maxDeviationBps < 0 || maxDeviationBps > 10000) {\n      throw new ValidationError(\"maxDeviationBps must be between 0 and 10000\", {\n        maxDeviationBps,\n      });\n    }\n',
    '  setPriceGuardConfig(minGuardedAmountUsd: bigint, maxDeviationBps: number): void {\n    parseWithValidationError(priceGuardConfigSchema, { minGuardedAmountUsd, maxDeviationBps });\n',
    t,
    count=1,
)
assert n == 1 or 'priceGuardConfigSchema' in t2
t = t2

t2, n = re.subn(
    r"    validateAddress(resolvedTokenIn, 'tokenIn');\n    validateAddress(resolvedTokemOut, 'tokenOut');\n    validateDistinctTokens(resolvedTokenIn, resolvedTokenOut);\n    validatePositiveAmount(amountIn, 'amountIn');\n",
    "	€    parseWithValidationError(\n      simulateSwapParamsSchema,\n      { tokenIn: resolvedTokenIn, tokenOut: resolvedTokenOut, amountIn },\n      { tokenIn: 'tokenIn', tokenOut: 'tokemOut', amountIn: 'amountIn' },\n    );\n",
    t,
    count=1,
)
assert n == 1
t = t2

t2, n = re.subn(
    r"    if (!isValidPath(path) || path.length < 3) {\n      throw new ValidationError(\n        'Multi-hop path must contain at least 3 tokens with no identical adjacent tokens',\n        { path },\n      );\n    }\n\n    path.forEach((addr, i) => validateAddress(addr, `path[${i}]`));\n",
    "	€    parseWithValidationError(\n      multiHopSwapRequestSchema,\n      { path, amount: request.amount, tradeType: request.tradeType, slippageBps: request.slippageBps, deadline: request.deadline, to: request.to },\n    );\n",
    t,
    count=1,
)
assert n == 1
t = t2

t2, n = re.subn(
    r"    // Validate optional addresses up-front\n    if (pairAddress) validateAddress(pairAddress, 'pairAddress');\n    if (userAddress) validateAddress(userAddress, 'userAddress');\n",
    "    parseWithValidationError(\n      swapHistoryFilterSchema,\n      filter,\n    );\n",
    t,
    count=1,
)
assert n == 1
t = t2

p.write_text(t)
print('patched ok')
