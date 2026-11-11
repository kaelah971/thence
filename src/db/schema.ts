/**
 * Thence backend — relational schema (B0 foundation).
 *
 * Conventions:
 * - UUID primary keys (`id`), explicit `created_at` / `updated_at` timestamps.
 * - Scoped ownership: every user-owned row carries an owner/creator FK;
 *   cross-user access must always filter by it (enforced at API layer, B2+).
 * - Exact-value amounts: atomic-unit integers as TEXT with a `^[0-9]+$`
 *   CHECK — never floats, never double precision.
 * - No custody: no private keys, mnemonics, preimages or recovery secrets.
 *   Transfer proofs carry only public/non-secret identifiers.
 */
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/* ------------------------------------------------------------------ */
/* users                                                               */
/* ------------------------------------------------------------------ */

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Nimiq address — wallet identity anchor. No password. */
    nimiqAddress: varchar("nimiq_address", { length: 128 }).notNull().unique(),
    /** F2: preferred display name (not a legal identity). Null until onboarding completes. */
    displayName: varchar("display_name", { length: 32 }),
    /** F2: set once when onboarding completes; never cleared by clients. */
    onboardingCompletedAt: timestamp("onboarding_completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("users_created_at_idx").on(t.createdAt),
    check("users_display_name_nonempty", sql`${t.displayName} IS NULL OR char_length(${t.displayName}) > 0`),
  ],
);

/* ------------------------------------------------------------------ */
/* auth_challenges + sessions (shape only — verification logic is B1)   */
/* ------------------------------------------------------------------ */

export const authChallenges = pgTable(
  "auth_challenges",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /**
     * Expected signer address when known up front. NULL when the signer is
     * chosen by Nimiq Pay at sign time (the normal Mini App flow) — the
     * verified address then comes from the signed public key instead.
     * When set, verification requires derived address equality.
     */
    nimiqAddress: varchar("nimiq_address", { length: 128 }),
    /** Opaque single-use challenge string. Not a secret that moves funds. */
    challenge: text("challenge").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("auth_challenges_address_idx").on(t.nimiqAddress),
    index("auth_challenges_expires_idx").on(t.expiresAt),
  ],
);

export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /**
     * SHA-256 hex of the opaque session token. The token itself never
     * touches PostgreSQL — only its hash (B1 session security).
     */
    tokenHash: text("token_hash").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("sessions_user_idx").on(t.userId),
    index("sessions_expires_idx").on(t.expiresAt),
  ],
);

/* ------------------------------------------------------------------ */
/* auth_rate_limits — deployment-safe fixed-window counters (B1)        */
/* ------------------------------------------------------------------ */

export const authRateLimits = pgTable(
  "auth_rate_limits",
  {
    /** Scope + client key, e.g. "challenge:203.0.113.7". Never a secret. */
    key: varchar("key", { length: 160 }).notNull(),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    count: integer("count").notNull().default(1),
  },
  (t) => [uniqueIndex("auth_rate_limits_key_window_uidx").on(t.key, t.windowStart)],
);

/* ------------------------------------------------------------------ */
/* recipients                                                          */
/* ------------------------------------------------------------------ */

export const recipients = pgTable(
  "recipients",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    displayName: varchar("display_name", { length: 120 }).notNull(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("recipients_owner_idx").on(t.ownerUserId),
    index("recipients_owner_archived_idx").on(t.ownerUserId, t.archivedAt),
    check("recipients_display_name_nonempty", sql`char_length(${t.displayName}) > 0`),
  ],
);

export const recipientVerifications = pgTable(
  "recipient_verifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    address: text("address").notNull(),
    network: varchar("network", { length: 32 }).notNull(),
    /** Bound asset of the destination triple (B2.3). */
    asset: varchar("asset", { length: 16 }),
    /**
     * Exact bound challenge message (purpose, app, destination triple,
     * nonce, expiry, no-payment disclaimer). Server-stored; signed as-is.
     */
    challenge: text("challenge").notNull().unique(),
    /** Recipient signature over the challenge — proof of control, not a fund-moving secret. */
    signature: text("signature"),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    verifiedByUserId: uuid("verified_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    /**
     * B2.3: public bearer token hash (SHA-256 hex). The raw token never
     * touches PostgreSQL — only its hash, mirroring B1 session storage.
     */
    tokenHash: text("token_hash").unique(),
    /**
     * Saved destination this proof is bound to. Plain column (no FK) to
     * avoid a circular table reference; deletes cascade in app code
     * (see deleteDestination in src/lib/recipients.ts).
     */
    destinationId: uuid("destination_id"),
    /** Authenticated payer who initiated verification for their record. */
    initiatedByUserId: uuid("initiated_by_user_id").references(() => users.id, {
      onDelete: "cascade",
    }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("recipient_verifications_address_idx").on(t.address),
    index("recipient_verifications_destination_idx").on(t.destinationId),
    // B2.3.1: one ACTIVE proof process per destination. Same address on
    // different users' destinations must verify independently, so the old
    // UNIQUE(address, network) is gone. History rows (consumed) are exempt.
    uniqueIndex("recipient_verifications_destination_active_uidx")
      .on(t.destinationId)
      .where(sql`${t.consumedAt} IS NULL`),
    check("recipient_verifications_address_nonempty", sql`char_length(${t.address}) > 0`),
  ],
);

export const recipientDestinations = pgTable(
  "recipient_destinations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    recipientId: uuid("recipient_id")
      .notNull()
      .references(() => recipients.id, { onDelete: "cascade" }),
    asset: varchar("asset", { length: 16 }).notNull(),
    network: varchar("network", { length: 32 }).notNull(),
    address: text("address").notNull(),
    /** Optional human-readable label, e.g. "Base savings". */
    label: varchar("label", { length: 120 }),
    isDefault: boolean("is_default").notNull().default(false),
    verificationId: uuid("verification_id").references(() => recipientVerifications.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("recipient_destinations_recipient_idx").on(t.recipientId),
    index("recipient_destinations_address_network_idx").on(t.address, t.network),
    // At most one default destination per recipient (enforced at the DB
    // level as a backstop; app updates use a single atomic statement).
    uniqueIndex("recipient_destinations_single_default_uidx")
      .on(t.recipientId)
      .where(sql`${t.isDefault} = TRUE`),
    check("recipient_destinations_address_nonempty", sql`char_length(${t.address}) > 0`),
  ],
);

/* ------------------------------------------------------------------ */
/* payment_requests                                                    */
/* ------------------------------------------------------------------ */

export const paymentRequests = pgTable(
  "payment_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    creatorUserId: uuid("creator_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Opaque public share identifier (URL-safe, generated app-side). */
    publicId: varchar("public_id", { length: 64 }).notNull().unique(),
    /** Payer-facing recipient display name — snapshot, not a recipient-book FK. */
    recipientName: varchar("recipient_name", { length: 120 }).notNull(),
    asset: varchar("asset", { length: 16 }).notNull(),
    network: varchar("network", { length: 32 }).notNull(),
    destination: text("destination").notNull(),
    /** Exact requested amount in atomic units (canonical uint string). */
    amountAtomic: text("amount_atomic").notNull(),
    memo: varchar("memo", { length: 280 }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    openedAt: timestamp("opened_at", { withTimezone: true }),
    /** Cancellation is terminal and idempotent; terms stay immutable. */
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("payment_requests_creator_idx").on(t.creatorUserId),
    index("payment_requests_expires_idx").on(t.expiresAt),
    check("payment_requests_amount_atomic_format", sql`${t.amountAtomic} ~ '^[0-9]+$'`),
    check("payment_requests_destination_nonempty", sql`char_length(${t.destination}) > 0`),
  ],
);

/* ------------------------------------------------------------------ */
/* transfers                                                           */
/* ------------------------------------------------------------------ */

export const transfers = pgTable(
  "transfers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    recipientId: uuid("recipient_id").references(() => recipients.id, {
      onDelete: "set null",
    }),
    requestId: uuid("request_id").references(() => paymentRequests.id, {
      onDelete: "set null",
    }),
    /** Canonical route id (see src/domain/routes.ts ROUTE_IDS). */
    routeId: varchar("route_id", { length: 32 }).notNull(),
    /**
     * Saved destination this intent was built from (nullable; history is
     * carried by the immutable snapshot below, never by this link).
     */
    recipientDestinationId: uuid("recipient_destination_id").references(() => recipientDestinations.id, {
      onDelete: "set null",
    }),
    targetAsset: varchar("target_asset", { length: 16 }).notNull(),
    targetNetwork: varchar("target_network", { length: 32 }).notNull(),
    destination: text("destination").notNull(),
    /** Exact recipient amount in atomic units (canonical uint string). */
    targetAmountAtomic: text("target_amount_atomic").notNull(),
    /**
     * Immutable recipient display-name snapshot (B4.1). Copied from the
     * saved recipient or payment request at creation; later renames never
     * rewrite history.
     */
    recipientName: varchar("recipient_name", { length: 120 }),
    /** Quote metadata (B4.1, non-secret provider observations only). */
    quoteProvider: varchar("quote_provider", { length: 32 }),
    /** Optimistic-concurrency revision, bumped on every requote. */
    quoteRevision: integer("quote_revision").notNull().default(1),
    /** Provider observation timestamp of the bound quote. */
    quotedAt: timestamp("quoted_at", { withTimezone: true }),
    /** Provider-confirmed net target (must equal the requested amount). */
    quotedNetTargetAtomic: text("quoted_net_target_atomic"),
    /** Required source in Lightning sats (NOT a NIM debit). */
    quotedSourceSats: text("quoted_source_sats"),
    /** Fee breakdown with explicit units, e.g. sats + protocol rate. */
    quotedFeesJson: jsonb("quoted_fees_json"),
    /** Provider min/max that applied, in sats. */
    quotedLimitsJson: jsonb("quoted_limits_json"),
    /** Domain status (see TRANSFER_STATUSES). */
    status: varchar("status", { length: 32 }).notNull().default("DRAFT"),
    /** Client-supplied idempotency key; scoped per owner. */
    idempotencyKey: varchar("idempotency_key", { length: 128 }),
    quoteExpiresAt: timestamp("quote_expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("transfers_owner_idx").on(t.ownerUserId),
    index("transfers_owner_status_idx").on(t.ownerUserId, t.status),
    index("transfers_recipient_idx").on(t.recipientId),
    index("transfers_status_idx").on(t.status),
    uniqueIndex("transfers_owner_idempotency_uidx").on(t.ownerUserId, t.idempotencyKey),
    check("transfers_amount_atomic_format", sql`${t.targetAmountAtomic} ~ '^[0-9]+$'`),
    check("transfers_destination_nonempty", sql`char_length(${t.destination}) > 0`),
    check("transfers_quoted_net_target_format", sql`${t.quotedNetTargetAtomic} IS NULL OR ${t.quotedNetTargetAtomic} ~ '^[0-9]+$'`),
    check("transfers_quoted_source_format", sql`${t.quotedSourceSats} IS NULL OR ${t.quotedSourceSats} ~ '^[0-9]+$'`),
  ],
);

/* ------------------------------------------------------------------ */
/* transfer_proofs (public/non-secret identifiers only)                */
/* ------------------------------------------------------------------ */

export const transferProofs = pgTable(
  "transfer_proofs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    transferId: uuid("transfer_id")
      .notNull()
      .unique()
      .references(() => transfers.id, { onDelete: "cascade" }),
    nimiqTxHash: text("nimiq_tx_hash"),
    lightningHash: text("lightning_hash"),
    satoraSwapId: text("satora_swap_id"),
    evmTxHash: text("evm_tx_hash"),
    /* B4.4 — structured settlement evidence (all independently verified, never client-supplied). */
    /** Evidence source/kind, e.g. 'evm_erc20_transfer'. */
    evidenceSource: varchar("evidence_source", { length: 32 }),
    /** EVM chain id of the verified settlement transaction. */
    chainId: integer("chain_id"),
    /** ERC20 token contract that emitted the matched Transfer event(s). */
    tokenContract: text("token_contract"),
    /** Destination address credited, lowercased at write time. */
    recipient: text("recipient"),
    /** Summed credited atomic units (canonical uint string). */
    verifiedAmountAtomic: text("verified_amount_atomic"),
    /** Receipt block number (fits safely in a JS number). */
    blockNumber: bigint("block_number", { mode: "number" }),
    blockHash: text("block_hash"),
    /** JSON array of matched ERC20 Transfer log indexes within the receipt. */
    logIndexes: text("log_indexes"),
    /** Finality classification at verification time, e.g. 'finalized'. */
    finalityLevel: varchar("finality_level", { length: 32 }),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // One on-chain settlement event funds at most one Thence transfer:
    // the same (chain, claim tx) can never be attributed twice.
    uniqueIndex("transfer_proofs_claim_uidx")
      .on(t.chainId, t.evmTxHash)
      .where(sql`${t.evmTxHash} IS NOT NULL`),
  ],
);

/* ------------------------------------------------------------------ */
/* handoff_attempts — durable pre-funding preparation (B4.2)            */
/* ------------------------------------------------------------------ */

export const handoffAttempts = pgTable(
  "handoff_attempts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    transferId: uuid("transfer_id")
      .notNull()
      .references(() => transfers.id, { onDelete: "cascade" }),
    /**
     * Opaque bearer token hash (SHA-256). Raw token is returned once at
     * creation (and on idempotent replay to the authenticated owner) and
     * never stored. Scoped to this attempt only — not a payment capability.
     */
    attemptTokenHash: text("attempt_token_hash").notNull().unique(),
    /** Transfer quote revision this attempt is bound to. */
    quoteRevision: integer("quote_revision").notNull(),
    /**
     * PREPARED → SWAP_ATTACHED → HANDOFF_AUTHORIZED, or SUPERSEDED when a
     * newer explicit preparation replaces an expired/ambiguous attempt.
     * Expiry is computed (expires_at), never silently auto-unlocking.
     */
    status: varchar("status", { length: 32 }).notNull().default("PREPARED"),
    satoraSwapId: text("satora_swap_id"),
    /** Client-reported IndexedDB durability acknowledgement (NOT independent proof). */
    recoveryAcknowledged: boolean("recovery_acknowledged").notNull().default(false),
    handoffAuthorizedAt: timestamp("handoff_authorized_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("handoff_attempts_transfer_idx").on(t.transferId),
    // One active attempt per transfer: concurrent prepares converge.
    uniqueIndex("handoff_attempts_single_active_uidx")
      .on(t.transferId)
      .where(sql`${t.status} IN ('PREPARED', 'SWAP_ATTACHED')`),
  ],
);

/* ------------------------------------------------------------------ */
/* swap_attachments — verified provider swaps bound to transfers (B4.2)  */
/* ------------------------------------------------------------------ */

export const swapAttachments = pgTable(
  "swap_attachments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    transferId: uuid("transfer_id")
      .notNull()
      .unique()
      .references(() => transfers.id, { onDelete: "cascade" }),
    attemptId: uuid("attempt_id")
      .notNull()
      .references(() => handoffAttempts.id, { onDelete: "cascade" }),
    /** Globally unique: one Satora swap authorizes at most one transfer. */
    satoraSwapId: text("satora_swap_id").notNull().unique(),
    /** BOLT11 hold invoice (paying it costs money; viewing it is safe). */
    invoiceBolt11: text("invoice_bolt11").notNull(),
    /** Payment hash (hash lock, 0x hex). The preimage itself is never stored. */
    paymentHash: text("payment_hash").notNull(),
    /** Exact source in sats as created. Never silently approved above quote. */
    sourceSats: text("source_sats").notNull(),
    /** Exact destination atomic units; must equal the transfer amount. */
    targetAtomic: text("target_atomic").notNull(),
    invoiceExpiresAt: timestamp("invoice_expires_at", { withTimezone: true }),
    /**
     * P2: Polygon claim deadline = Satora `evm_refund_locktime`, stored only
     * after strict identity verification. Fixed at swap creation. NOT the
     * Lightning invoice expiry and NOT Nimiq Pay's NIM HTLC timeout.
     * Nullable: rows bound before P2 are backfilled by reconciliation.
     */
    evmRefundLocktime: timestamp("evm_refund_locktime", { withTimezone: true }),
    /** Provider status snapshot at verification time (e.g. pending). */
    providerStatus: varchar("provider_status", { length: 64 }),
    verifiedAt: timestamp("verified_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("swap_attachments_attempt_idx").on(t.attemptId),
    check("swap_attachments_source_format", sql`${t.sourceSats} ~ '^[0-9]+$'`),
    check("swap_attachments_target_format", sql`${t.targetAtomic} ~ '^[0-9]+$'`),
  ],
);

/* ------------------------------------------------------------------ */
/* reconciliation_observations — read-only provider reads (B4.3)        */
/* ------------------------------------------------------------------ */

export const reconciliationObservations = pgTable(
  "reconciliation_observations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    transferId: uuid("transfer_id")
      .notNull()
      .references(() => transfers.id, { onDelete: "cascade" }),
    /** Provider swap id observed (never client-supplied here). */
    satoraSwapId: text("satora_swap_id").notNull(),
    /** Raw provider status string (pending, clientfunded, ...). */
    providerStatus: varchar("provider_status", { length: 64 }).notNull(),
    /** Classification of this read: observation vs safe error. */
    kind: varchar("kind", { length: 32 }).notNull().default("observation"),
    /** Machine-readable error when the read itself failed (no state change). */
    errorCode: varchar("error_code", { length: 64 }),
    /** Non-secret on-chain identifiers echoed by the provider, if any. */
    evmFundTxid: text("evm_fund_txid"),
    evmClaimTxid: text("evm_claim_txid"),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("reconciliation_observations_transfer_idx").on(t.transferId, t.observedAt),
    check(
      "reconciliation_observations_kind_format",
      sql`${t.kind} IN ('observation', 'provider_error', 'identity_mismatch')`,
    ),
  ],
);

/* ------------------------------------------------------------------ */
/* transfer_transitions (P4 audit trail)                               */
/* ------------------------------------------------------------------ */

/**
 * Append-only audit of transfer status transitions written by the
 * reconciler and the evidence-gated terminal resolution. Each row records
 * who moved the transfer, from what, to what, why, and the non-secret
 * evidence relied on (provider status, tx-id presence, chain scan window and
 * result). Never stores invoices, preimages or credentials. The gated source
 * proof path may also retain the independently verified public Nimiq sender,
 * amount, network, hash and finality fields needed by the proof API.
 *
 * A transfer can enter a terminal status at most once (partial unique
 * index), which makes terminal resolution idempotent under concurrency even
 * if two writers raced past the row lock.
 */
export const transferTransitions = pgTable(
  "transfer_transitions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    transferId: uuid("transfer_id")
      .notNull()
      .references(() => transfers.id, { onDelete: "cascade" }),
    fromStatus: varchar("from_status", { length: 32 }).notNull(),
    toStatus: varchar("to_status", { length: 32 }).notNull(),
    /** owner (session action), reconciler (provider-evidence advance), operator. */
    actor: varchar("actor", { length: 16 }).notNull(),
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    /** Machine-readable reason, e.g. EXPIRED_UNFUNDED_VERIFIED, PROVIDER_SERVER_FUNDED. */
    reasonCode: varchar("reason_code", { length: 64 }).notNull(),
    /** Non-secret evidence snapshot relied on for this transition. */
    evidence: jsonb("evidence").notNull().default(sql`'{}'::jsonb`),
    terminal: boolean("terminal").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("transfer_transitions_transfer_idx").on(t.transferId, t.createdAt),
    uniqueIndex("transfer_transitions_terminal_once").on(t.transferId).where(sql`${t.terminal} = true`),
    check("transfer_transitions_actor_format", sql`${t.actor} IN ('owner', 'reconciler', 'operator')`),
  ],
);

/* ------------------------------------------------------------------ */
/* job_leases (P6: single-runner lease for scheduled jobs)             */
/* ------------------------------------------------------------------ */

/**
 * One row per scheduled job. A run acquires the lease with a single atomic
 * upsert (no long-held database lock): only when the previous lease expired
 * AND the previous start is older than the minimum spacing. This absorbs
 * overlapping invocations and duplicate deliveries of the same scheduled run.
 * `last_summary` holds non-secret counters for observability.
 */
export const jobLeases = pgTable("job_leases", {
  name: varchar("name", { length: 64 }).primaryKey(),
  holder: varchar("holder", { length: 64 }).notNull(),
  acquiredAt: timestamp("acquired_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  lastStartedAt: timestamp("last_started_at", { withTimezone: true }),
  lastFinishedAt: timestamp("last_finished_at", { withTimezone: true }),
  lastSummary: jsonb("last_summary"),
});

/* ------------------------------------------------------------------ */
/* route_observations (availability diagnostics, not a pricing promise) */
/* ------------------------------------------------------------------ */

export const routeObservations = pgTable(
  "route_observations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    routeId: varchar("route_id", { length: 32 }).notNull(),
    minAtomic: text("min_atomic"),
    maxAtomic: text("max_atomic"),
    /** Observed fee in atomic units of the target asset (diagnostic only). */
    feeAtomic: text("fee_atomic"),
    /** Observed bridge fee leg (e.g. CCTP) in atomic units (diagnostic only). */
    bridgeFeeAtomic: text("bridge_fee_atomic"),
    source: varchar("source", { length: 64 }).notNull().default("satora-quote"),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("route_observations_route_observed_idx").on(t.routeId, t.observedAt),
    check("route_observations_min_format", sql`${t.minAtomic} IS NULL OR ${t.minAtomic} ~ '^[0-9]+$'`),
    check("route_observations_max_format", sql`${t.maxAtomic} IS NULL OR ${t.maxAtomic} ~ '^[0-9]+$'`),
  ],
);

/* ------------------------------------------------------------------ */
/* pilot_controls (F8.2 — database-backed pilot kill switch)              */
/* ------------------------------------------------------------------ */

/**
 * Singleton row (`id = 'pilot'`) gating NEW funded pilot execution.
 *
 * WHY THIS EXISTS: Vercel environment-variable changes only apply to NEW
 * deployments — even server-side variables. Toggling THENCE_PILOT_ENABLED
 * in the Vercel dashboard is therefore NOT an instantaneous emergency
 * switch. This row IS: flipping `enabled` takes effect on the next funded
 * request with no redeploy, on every already-running deployment.
 *
 * TWO-KEY RULE: funded execution requires BOTH the deployed env gate
 * (THENCE_PILOT_ENABLED=1 + owner allowlist + caps in src/lib/pilot.ts)
 * AND this row (`enabled = TRUE`). Either key stops new funding alone.
 *
 * SCOPE: only the five funded-execution paths read this row (transfer
 * create, requote, handoff prepare/attach/authorize). Recovery stays
 * available while stopped: reconcile, reconciliation resume, attempt
 * status, receipt, handoff outcome reports and settlement verification
 * never consult it, so an already-funded transfer can always be
 * recovered, reconciled and verified after an emergency stop.
 *
 * FAIL-CLOSED: the gate treats a missing row, missing table (pre-migration
 * database) or any read error as DISABLED. Unconfigured environments (no
 * owner allowlist) skip the pilot entirely and never read this table, so
 * legacy/quote-only flows and old databases keep working.
 */
export const pilotControls = pgTable("pilot_controls", {
  /** Singleton id; only 'pilot' is used. */
  id: text("id").primaryKey().default("pilot"),
  /** Database kill switch. FALSE = no new funded pilot execution. */
  enabled: boolean("enabled").notNull().default(false),
  /** Session user who last flipped the switch (audit, nullable). */
  updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
  /** Operator note for the last change (audit, nullable). */
  note: varchar("note", { length: 280 }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Transfer = typeof transfers.$inferSelect;
export type NewTransfer = typeof transfers.$inferInsert;
