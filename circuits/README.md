# Circuit artifacts — Proof Gatekeeper (Groth16 / BN128, Circom 2.x)

Downloaded 2026-11-14 from the Agent Games Playbook
(https://agentgames.zkverify.io/build, §02.5 "Circuit artifacts"; URLs from
https://agentgames.zkverify.io/api/circuit-info):

| File | Size | SHA-256 |
|---|---|---|
| `gatekeeper.wasm` | 1,755,820 bytes | `be00aefe3c8ba910951a242f50e55937bf82a0375ad4b69c2ef10629ab92764f` |
| `gatekeeper_final.zkey` | 309,750 bytes | `adfe95a439a7063a82a4967ef026d2dd6857a4d02c63b3caf63dac02e01af80d` |

Total ~2 MB — small enough to commit, so the agent runs with proofs out of
the box wherever the repo is cloned. No file hashes are published on the
Playbook page, so the SHA-256 values above are recorded here for future
verification (re-download and compare).

Registered verification-key hash on zkVerify mainnet (from
`/api/circuit-info`; also the `vk` value sent to Kurier — see
`proof.js` `GATEKEEPER_VK_HASH`):

```
0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0
```

NOTE: the vk_hash values transcribed from Playbook screenshots in an
earlier note were truncated/mangled by screenshot OCR — the values served
live by `/api/circuit-info` are authoritative and are the ones used here.

## Re-download

```bash
curl -sS -L -o circuits/gatekeeper.wasm \
  https://agentgames.zkverify.io/circuits/gatekeeper.wasm
curl -sS -L -o circuits/gatekeeper_final.zkey \
  https://agentgames.zkverify.io/circuits/gatekeeper_final.zkey
sha256sum circuits/gatekeeper.wasm circuits/gatekeeper_final.zkey
# compare with the table above
```

## What the circuit proves

Template `GatekeeperEvaluation` (13 input signals, 13 public signals).
Input signal names (discovered empirically by probing this wasm — the
Playbook does not publish them; see `proof.js` `buildCircuitInputs()`):

`recipient`, `conditionRecipient`, `amount`, `maxTransfer`, `minimum`,
`publicBalance`, `expiryBlock`, `currentBlock`, `decision`, `taskId`,
`registeredVkHash`, `proofVkHash`, `salt`.

Public signals, in order:

```
[ Poseidon(salt, taskId), registeredVkHash, proofVkHash, minimum,
  publicBalance, expiryBlock, currentBlock, recipient,
  conditionRecipient, amount, maxTransfer, decision, taskId ]
```

Public signal 0 — `Poseidon(salt, taskId)` — is the proof reference
(nullifier) binding the proof to its task. The circuit enforces decision
correctness: a decision inconsistent with the checks fails witness
generation (assert in the template), so only the decision `decide.js`
already computed is ever proven.
