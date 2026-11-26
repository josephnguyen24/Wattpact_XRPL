import { connect } from "../xrpl/client.js";

const client = await connect();
console.log("Connecté à", client.url);
const ledger = await client.request({ command: "ledger", ledger_index: "validated" });
console.log("Dernier ledger validé :", ledger.result.ledger_index);
await client.disconnect();
