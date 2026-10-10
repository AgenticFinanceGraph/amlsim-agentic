/* The liveness ladder, frozen. This is the ONE implementation — a tile and the
   graph can never disagree because they call this. Published verbatim at
   /ai-agent-liveness-methodology-l0-l9-ladder. Do not invent L10.

   The whole product claim lives here: registration is not liveness, and public
   rank starts at L7 where a bound wallet has actually paid. */
export const DUST_USD = 10;        // L8 floor
export const REPEAT_N = 3;         // L9 distinct counterparties
export const REPEAT_WINDOW_D = 30;
export const PUBLIC_MIN_LEVEL = 7;

export const RUNGS = [
  [0, "identity exists in a registry"],
  [1, "URI or metadata is non-empty"],
  [2, "URI answers 2xx within 8s"],
  [3, "body is valid ERC-8004 JSON or an Agentverse card"],
  [4, "services[] or endpoints[] declared"],
  [5, "at least one endpoint answers 2xx within 8s"],
  [6, "speaks MCP (tools/list) or A2A (agent-card.json)"],
  [7, "bound wallet has >= 1 non-inferred PAY"],
  [8, "bound wallet stable float >= DUST_USD"],
  [9, ">= REPEAT_N distinct counterparties in REPEAT_WINDOW_D days"]
];

/* Caps exist so a platform sink cannot masquerade as a live service. */
export const HOSTED_SINK_CAP = 4;   // agentverse.ai/v1/hosting/submit and friends
export const UNGRADUATED_CAP = 4;   // Virtuals graduated=false with no ACP payment

export function score(f = {}) {
  const {
    hasIdentity = false, uriNonEmpty = false, uriOk = false, schemaValid = false,
    servicesDeclared = false, endpointOk = false, speaksProtocol = false,
    nonInferredPayCount = 0, stableFloatUsd = 0, distinctCounterparties30d = 0,
    hostedSink = false, ungraduatedNoRevenue = false
  } = f;

  let level = -1;
  if (hasIdentity) level = 0;
  if (level === 0 && uriNonEmpty) level = 1;
  if (level === 1 && uriOk) level = 2;
  if (level === 2 && schemaValid) level = 3;
  if (level === 3 && servicesDeclared) level = 4;
  if (level === 4 && endpointOk) level = 5;
  if (level === 5 && speaksProtocol) level = 6;

  /* L7+ is about money, and it does not require the protocol rungs: a wallet
     that demonstrably paid is an economic actor whether or not it speaks MCP. */
  if (nonInferredPayCount >= 1) level = Math.max(level, 7);
  if (level >= 7 && stableFloatUsd >= DUST_USD) level = 8;
  if (level >= 8 && distinctCounterparties30d >= REPEAT_N) level = 9;

  const caps = [];
  if (hostedSink) caps.push(HOSTED_SINK_CAP);
  if (ungraduatedNoRevenue) caps.push(UNGRADUATED_CAP);
  if (caps.length) level = Math.min(level, Math.min(...caps));

  return Math.max(0, level);
}

export const isPublic = (level) => level >= PUBLIC_MIN_LEVEL;
