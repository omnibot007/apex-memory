/**
 * apex-memory — a write-side custody gate for agent memory.
 *
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 omnibot007
 */
export {
  admitCustody,
  corroborationOf,
  CustodyRefusedError,
  digest,
  isCorroborating,
  normalizeClaim,
  recallInForce,
  record,
  sourceCeiling,
  supersede,
} from './custody.js';

export {
  compactProject,
  planCompaction,
  type CompactionOptions,
  type CompactionReport,
  type RewritableStore,
} from './compaction.js';

export { defaultMemoryDir, JsonlCustodyStore, MemoryCustodyStore } from './store.js';

export {
  AUTHORITY_RANK,
  SOURCE_CEILING,
  type Authority,
  type CustodiedFact,
  type CustodyDenial,
  type CustodyGrant,
  type CustodyRefusal,
  type CustodyRequest,
  type CustodyStore,
  type CustodyVerdict,
  type FactKind,
  type RecallOptions,
  type SourceKind,
} from './types.js';
