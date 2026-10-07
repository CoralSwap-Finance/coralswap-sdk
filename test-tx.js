const { xdr, TransactionBuilder, Account, Contract } = require('@stellar/stellar-sdk');
const account = new Account("GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF", "1");
const contract = new Contract("CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC");
const op = contract.call("get_flash_config");
const tx = new TransactionBuilder(account, { fee: "100", networkPassphrase: "Test SDF Network ; September 2015" }).setTimeout(30).addOperation(op).build();
console.log(tx.operations[0].type);
try {
  const xdrTx = tx.toXDR();
  const opXdr = xdr.TransactionEnvelope.fromXDR(xdrTx).v1().tx().operations()[0];
  const func = opXdr.body().invokeHostFunctionOp().hostFunction().invokeContract().functionName().toString('utf-8');
  console.log("XDR Func:", func);
} catch (e) {
  console.log("Error XDR:", e);
}
