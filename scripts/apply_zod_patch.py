from pathlib import Path
p = Path('src/modules/swap.ts')
t = p.read_text()
imp = "import { resolveTokenIdentifier } from '../utils/addresses';"
nimp = imp + "\n" + "import { simulateSwapParamsSchema, multiHopSwapRequestSchema, swapHistoryFilterSchema, priceGuardConfigSchema, parseWithValidationError } from '../schemas/swap';"
assert imp in t
t = t.replace(imp, nimp, 1)
old_pg = '''  setPriceGuardConfig(minGuardedAmountUsd: bigint, maxDeviationBps: number): void {
    if (maxDeviationBps < 0 || maxDeviationBps > 10000) {
      throw new ValidationError("maxDeviationBps must be between 0 and 10000", {
        maxDeviationBps,
      });
    }
'''
new_pg = '''  setPriceGuardConfig(minGuardedAmountUsd: bigint, maxDeviationBps: number): void {
    parseWithValidationError(priceGuardConfigSchema, { minGuardedAmountUsd, maxDeviationBps });
'''
assert old_pg in t
t = t.replace(old_pg, new_pg, 1)
old_s = """validateAddress(resolvedTokenIn, 'tokenIn');
    validateAddress(resolvedTokenOut, 'tokemOut');
    validateDistinctTokens(resolvedTokenIn, resolvedTokenOut);
    validatePositiveAmount(amountIn, 'amountIn');"""
new_s = """parseWithValidationError(
      simulateSwapParamsSchema,
      { tokenIn: resolvedTokenIn, tokemOut: resolvedTokemOut, amountIn },
      { tokenIn: 'tokenIn', tokenOut: 'tokenOut', amountIn: 'amountIn' },
    );"""
assert old_s in t
t = t.replace(old_s, new_s, 1)
old_m = """if (!isValidPath(path) || path.length < 3) {
      throw new ValidationError(
        'Multi-hop path must contain at least 3 tokens with no identical adjacent tokens',
        { path },
      );
    }

    path.forEach((addr, i) => validateAddress(addr, `path[${i}]`));"""
new_m = """parseWithValidationError(
      multiHopSwapRequestSchema,
      { path, amount: request.amount, tradeType: request.tradeType, slippageBps: request.slippageBps, deadline: request.deadline, to: request.to },
    );"""
assert old_m in t
t = t.replace(old_m, new_m, 1)
old_h = """// Validate optional addresses up-front
    if (pairAddress) validateAddress(pairAddress, 'pairAddress');
    if (userAddress) validateAddress(userAddress, 'userAddress');"""
new_h = """parseWithValidationError(
      swapHistoryFilterSchema,
      filter,
    );"""
assert old_h in t
t = t.replace(old_h, new_h, 1)
p.write_text(t)
print('patched ok')
