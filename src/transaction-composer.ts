import { xdr } from "@stellar/stellar-sdk";
import { CoralSwapClient } from "./client";

export class TransactionComposer {
  private operations: xdr.Operation[] = [];

  constructor(private readonly client: CoralSwapClient) {}

  addOperation(operation: xdr.Operation): this {
    this.operations.push(operation);
    return this;
  }

  clear(): this {
    this.operations = [];
    return this;
  }

  async submit() {
    return this.client.submitTransaction(this.operations);
  }

  async estimate() {
    return this.client.simulateTransaction(this.operations, {});
  }

  getOperations(): readonly xdr.Operation[] {
    return this.operations;
  }
}
