import { GasEstimate } from './gas';

/**
 * Detailed fee estimates returned by getFeeEstimates()
 */
export interface FeeEstimates {
  /** Gas fee estimate (stroops, XLM string, optional USD) */
  gas: GasEstimate;

  /** Protocol fee in basis points */
  protocolFeeBps: number;

  /** Protocol fee amount in stroops */
  protocolFeeStroops: number;

  /** Total fee (gas + protocol) in stroops */
  totalStroops: number;

  /** Total fee in XLM as string */
  totalXLM: string;

  /** Current ledger sequence number used for estimation */
  ledger: number;

  /** Resource budget details if available */
  resources?: {
    instructions: number;
    readBytes: number;
    writeBytes: number;
  };

  /** Breakdown of fee components */
  breakdown: {
    gas: {
      stroops: number;
      xlm: string;
    };
    protocol: {
      bps: number;
      stroops: number;
      xlm: string;
    };
  };
}
