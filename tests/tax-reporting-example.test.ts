import {
  buildTaxReconciliationExample,
  paginateExportRows,
} from "../examples/tax-reporting";

describe("tax-reporting example", () => {
  it("builds a per-period summary from fixture event history", async () => {
    const report = await buildTaxReconciliationExample();

    expect(report.periodSummaries.length).toBeGreaterThan(0);
    expect(report.periodSummaries[0]).toEqual(
      expect.objectContaining({
        period: expect.any(String),
        shortTermGains: expect.any(String),
        netGain: expect.any(String),
      }),
    );
    expect(report.pages.length).toBeGreaterThan(0);
    expect(report.pages[0].length).toBeGreaterThan(0);
  });

  it("paginates export rows into manageable chunks", () => {
    const rows = Array.from({ length: 5 }, (_, index) => ({
      txHash: `tx-${index}`,
    }));

    const pages = paginateExportRows(rows, 2);
    expect(pages).toHaveLength(3);
    expect(pages[0]).toHaveLength(2);
    expect(pages[2]).toHaveLength(1);
  });
});
