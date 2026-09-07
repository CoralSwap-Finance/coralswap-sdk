const { TransactionBuilder, Account, Contract } = require('@stellar/stellar-sdk');
const account = new Account("GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF", "1");
const contract = new Contract("CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC");
const op = contract.call("get_flash_config");
const tx = new TransactionBuilder(account, { fee: "100", networkPassphrase: "Test SDF Network ; September 2015" }).setTimeout(30).addOperation(op).build();

console.log(Object.keys(tx.operations[0].func.invokeContract.functionName));
console.log(typeof tx.operations[0].func.invokeContract.functionName.toString);
console.log(tx.operations[0].func.invokeContract.functionName.toString('utf-8'));
