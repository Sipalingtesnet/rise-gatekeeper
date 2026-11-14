# rise — Proof Gatekeeper agent

**rise** is an AI-agent entry for the **Proof Gatekeeper** track of
[zkVerify Agent Games, Season 01](https://agentgames.zkverify.io) (21 Oct –
21 Nov 2026). It is a small, zero-dependency Node.js service that answers
incoming gatekeeper tasks with an `APPROVE` / `REJECT` decision.

## The game

In Proof Gatekeeper the arena sends the agent incoming tasks — proof-backed
payment requests — and the agent must decide whether to approve them. The
decision boundary is strict:

> **APPROVE only when every field agrees. Anything else is a REJECT.**

The arena's own preview lists these outcomes:

| Reason | Meaning |
|---|---|
| `VALID_CONDITION` | Everything agrees → **APPROVE** |
| `VK_SUBSTITUTION` | The proof verification key differs from the committed one → **REJECT** |
| `RECIPIENT_MISMATCH` | The recipient differs from the committed one → **REJECT** |
| `THRESHOLD_MISMATCH` | The amount is above the committed maximum (or missing/invalid) → **REJECT** |

`rise` implements exactly that boundary, and it **fails closed**: if any
reference value is missing, the task is rejected rather than approved on
incomplete data.

## API

### `GET /health`

Health check for the arena.

```json
{ "status": "ok", "agent": "rise" }
```

### `POST /agent`

Submit one task, get one decision. Extra fields are tolerated and ignored.
A task `id` / `taskId` is echoed back as `taskId` when present.

Request:

```json
{
  "id": "gk_901",
  "recipient": "0xD0620000000000000000000000000000009F81",
  "expectedRecipient": "0xD0620000000000000000000000000000009F81",
  "amount": 1000,
  "maximum": 1000,
  "proofVk": "vk-abc-123",
  "expectedVk": "vk-abc-123"
}
```

Response:

```json
{ "decision": "APPROVE", "reason": "VALID_CONDITION", "agent": "rise", "taskId": "gk_901" }
```

Accepted field aliases (same meaning):

- amount: `amount`, `publicBalance`, `value`, `public_balance`
- maximum: `maximum`, `threshold`, `max`, `limit`
- proof VK: `proofVk`, `vk`, `proof_vk`
- expected VK: `expectedVk`, `expectedProofVk`, `committedVk`, `expected_vk`
- recipient: `recipient`, `to`, `payee`
- expected recipient: `expectedRecipient`, `committedRecipient`, `expected_recipient`

Checks, in order:

1. **Proof VK** — must match the expected VK exactly. Missing either side → `VK_SUBSTITUTION`.
2. **Recipient** — must match the expected recipient (case-insensitive, for hex addresses). Missing either side → `RECIPIENT_MISMATCH`.
3. **Threshold** — amount must be a non-negative number and `amount <= maximum`. Missing, non-numeric, negative, or above the cap → `THRESHOLD_MISMATCH`. Integer values are compared with `BigInt`, so large on-chain values do not lose precision.

A malformed (non-JSON, non-object) body gets HTTP 400; unknown paths get 404.

## Run locally

Requires Node.js 18+ and nothing else — no dependencies to install.

```bash
node server.js            # listens on :3000 (or $PORT)
```

Try it:

```bash
curl -s localhost:3000/health
curl -s -X POST localhost:3000/agent -H 'content-type: application/json' -d '{
  "recipient": "0xD0620000000000000000000000000000009F81",
  "expectedRecipient": "0xD0620000000000000000000000000000009F81",
  "amount": 1000, "maximum": 1000,
  "proofVk": "vk-abc-123", "expectedVk": "vk-abc-123"
}'
```

## Tests

```bash
npm test        # node --test test.js
```

The suite covers the pure decision logic (approve on a fully valid task,
reject on each of the three mismatch kinds, fail-closed on missing reference
values, boundary and alias cases) plus a live HTTP smoke test of `/health`
and `/agent`.

## Deploy as a service

The Agent Games registration form takes an optional agent endpoint, e.g.
`https://my-agent.fly.dev/agent`. One way to host this service is
[fly.io](https://fly.io):

```bash
fly launch --no-deploy   # answer the prompts, pick a region
fly deploy
fly open                 # check https://<app>.fly.dev/health
```

Then register the endpoint URL (`https://<app>.fly.dev/agent`) in the
Agent Games dashboard. Any other Node host works the same way — the service
only needs `node server.js` and a public URL.

## Honest note on the task schema

The exact JSON schema the arena sends to an agent endpoint is **not
published** (no public docs were found for it at the time this repo was
written). The field names above are taken from the arena's own preview
screen (maximum, public balance, proof VK, recipient) and the reason codes
from its recent-decisions list, plus common aliases. If the real arena
payload uses different field names, the mapping lives in one place —
`decide.js` (`pick(...)` calls) — and can be adjusted there without touching
the server.

## License

MIT — see [LICENSE](LICENSE).
