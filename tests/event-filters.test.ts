import {
  buildEventFilters,
  MAX_EVENT_FILTERS,
  MAX_FILTERED_CONTRACT_IDS,
} from "../src/utils/event-filters";
import {
  filterTrustedEvents,
  selectScanContractIds,
} from "../src/utils/registered-pairs";
import { ValidationError } from "../src/errors";

const contractIds = Array.from(
  { length: MAX_FILTERED_CONTRACT_IDS + 5 },
  (_, index) => `C${String(index).padStart(55, "A")}`,
);

describe("trusted-pair event filters", () => {
  it("splits a full registry across RPC-legal filters", () => {
    const trusted = contractIds.slice(0, MAX_FILTERED_CONTRACT_IDS);
    const filters = buildEventFilters(trusted, [["swap"]]);

    expect(filters).toHaveLength(MAX_EVENT_FILTERS);
    for (const filter of filters) {
      expect(filter.type).toBe("contract");
      expect(filter.contractIds).toHaveLength(5);
      expect(filter.topics).toEqual([["swap"]]);
    }
    expect(new Set(filters.flatMap((filter) => filter.contractIds)).size).toBe(
      MAX_FILTERED_CONTRACT_IDS,
    );
  });

  it("refuses to emit more filters than the RPC accepts", () => {
    expect(() => buildEventFilters(contractIds)).toThrow(ValidationError);
  });

  it("falls back to post-decode filtering when the registry is too large", () => {
    const trusted = new Set(contractIds);

    expect(selectScanContractIds(trusted)).toEqual([]);
    expect(
      filterTrustedEvents(
        [{ contractId: contractIds[0] }, { contractId: "CFORGED" }],
        trusted,
      ).map((event) => event.contractId),
    ).toEqual([contractIds[0]]);
  });

  it("returns no contract filter for an unregistered requested pair", () => {
    expect(
      selectScanContractIds(new Set([contractIds[0]]), "CFORGED-REQUEST"),
    ).toBeNull();
  });
});
