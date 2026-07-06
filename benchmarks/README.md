# CoralSwap SDK Benchmarks

Performance benchmarks for RPC-calling SDK methods. Results are emitted as JSON for CI integration and regression tracking.

## What is measured

Each operation reports:

| Metric | Description |
|--------|-------------|
| `cold_start_ms` | Latency of the first invocation (fresh context) |
| `avg_latency_ms` | Mean latency over warm iterations |
| `p99_latency_ms` | 99th percentile latency |
| `min_latency_ms` / `max_latency_ms` | Range across iterations |
| `stddev_ms` | Standard deviation (used to verify ±10 % variance) |
| `memory` | `heap_used_bytes`, `rss_bytes`, `external_bytes` after run |

## Benchmarked operations (15)

| Group | Operation |
|-------|-----------|
| `rpc` | `client.isHealthy`, `client.getCurrentLedger` |
| `swap` | `swap.getQuote`, `swap.getMultiHopQuote`, `swap.computeHops` |
| `portfolio` | `positions.getPositions`, `positions.getPosition` |
| `routing` | `router.findOptimalPath` |
| `analytics` | `fees.getCurrentFee`, `fees.estimateSwapFee`, `oracle.getSpotPrice`, `oracle.observe`, `pair.getReserves` |
| `liquidity` | `liquidity.getAddLiquidityQuote` |
| `factory` | `factory.getPairAddress` |

## Prerequisites

```bash
npm install
npm run build
```

## Run locally

```bash
# Print JSON to stdout
npm run benchmark

# Write JSON to a file (for CI artifacts)
npm run benchmark -- --output benchmarks/results.json
```

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `BENCHMARK_RPC_LATENCY_MS` | `5` | Simulated Soroban RPC round-trip delay per call |
| `BENCHMARK_ITERATIONS` | `50` | Warm iterations per operation |
| `BENCHMARK_VARIANCE_TARGET` | `10` | Documented variance target (±%) for reproducibility |

Fixed RPC latency keeps variance within ±10 % across runs without requiring a live network.

## JSON output format

```json
{
  "schema_version": "1.0",
  "tool": "coralswap-sdk-benchmarks",
  "timestamp": "2026-06-29T12:00:00.000Z",
  "environment": { "node": "v20.x", "platform": "darwin", "arch": "arm64", "cpus": 8 },
  "config": { "rpc_latency_ms": 5, "iterations": 50, "variance_target_percent": 10 },
  "results": [
    {
      "name": "swap.getQuote",
      "group": "swap",
      "unit": "milliseconds",
      "cold_start_ms": 18.2,
      "avg_latency_ms": 16.5,
      "p99_latency_ms": 19.1,
      "min_latency_ms": 15.8,
      "max_latency_ms": 19.5,
      "stddev_ms": 0.9,
      "iterations": 50,
      "memory": { "heap_used_bytes": 123456, "rss_bytes": 456789, "external_bytes": 1234 }
    }
  ]
}
```

This schema is compatible with common CI benchmark comparators (structured `name`, `group`, numeric metrics, ISO timestamp).

## CI integration example

```yaml
- name: Run SDK benchmarks
  run: npm run benchmark -- --output benchmarks/results.json

- name: Upload benchmark artifact
  uses: actions/upload-artifact@v4
  with:
    name: benchmark-results
    path: benchmarks/results.json
```
