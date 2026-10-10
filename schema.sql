-- The tables the detectors read, in the shape the live ledger has them (pg_dump of afg, 10 Oct 2026),
-- so the same queries run unchanged over synthetic rows. Loaded into a separate database (afg_sim).
CREATE TABLE IF NOT EXISTS actors (
    actor_id text NOT NULL PRIMARY KEY,
    display_name text,
    primary_wallet text,
    liveness smallint DEFAULT 0 NOT NULL,
    liveness_as_of timestamp with time zone,
    sources text[] DEFAULT '{}'::text[] NOT NULL,
    primary_chain text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    registered_at timestamp with time zone,
    CONSTRAINT actors_liveness_check CHECK (((liveness >= 0) AND (liveness <= 9)))
);
CREATE TABLE IF NOT EXISTS bindings (
    actor_id text NOT NULL,
    wallet text NOT NULL,
    valid_from timestamp with time zone NOT NULL,
    valid_to timestamp with time zone,
    bind_method smallint NOT NULL,
    confidence text NOT NULL,
    evidence_uri text,
    PRIMARY KEY (actor_id, wallet, valid_from),
    CONSTRAINT bindings_bind_method_check CHECK (((bind_method >= 0) AND (bind_method <= 5)))
);
CREATE TABLE IF NOT EXISTS money_events (
    event_id text NOT NULL PRIMARY KEY,
    actor_id text,
    kind text NOT NULL,
    rail text,
    from_caip10 text,
    to_id text,
    amount_usd numeric(38,6),
    asset text,
    tx text,
    block_time timestamp with time zone,
    confidence text NOT NULL,
    source text NOT NULL,
    pre_registration boolean DEFAULT false NOT NULL,
    pass_through boolean DEFAULT false NOT NULL,
    pass_checked_at timestamp with time zone,
    log_index integer,
    own_position boolean,
    own_checked_at timestamp with time zone,
    builder_code text,
    builder_checked_at timestamp with time zone
);
CREATE TABLE IF NOT EXISTS probes (
    id bigserial PRIMARY KEY,
    actor_id text,
    endpoint text NOT NULL,
    ok boolean NOT NULL,
    http_status integer,
    protocol text,
    rtt_ms integer,
    body_sha256 text,
    error_class text,
    at timestamp with time zone DEFAULT now() NOT NULL,
    flags text
);
CREATE TABLE IF NOT EXISTS registrations (
    chain_id integer NOT NULL,
    token_id bigint NOT NULL,
    minted_at timestamp with time zone NOT NULL,
    minted_to text,
    tx text,
    PRIMARY KEY (chain_id, token_id)
);
CREATE TABLE IF NOT EXISTS wallets (
    caip10 text NOT NULL PRIMARY KEY,
    kind text,
    first_seen timestamp with time zone,
    last_seen timestamp with time zone,
    usdc_float numeric(38,6),
    float_as_of timestamp with time zone,
    impl_7702 text,
    last_pay_check timestamp with time zone,
    last_code_check timestamp with time zone,
    stables_float numeric,
    float_breakdown jsonb,
    last_earn_check timestamp with time zone,
    pay_dirty_at timestamp with time zone,
    kind_checked_at timestamp with time zone
);
CREATE INDEX IF NOT EXISTS actors_rank ON actors USING btree (liveness DESC, liveness_as_of DESC);
CREATE INDEX IF NOT EXISTS bindings_open ON bindings USING btree (wallet) WHERE (valid_to IS NULL);
CREATE INDEX IF NOT EXISTS money_events_actor ON money_events USING btree (actor_id, block_time DESC);
CREATE INDEX IF NOT EXISTS money_events_countable ON money_events USING btree (actor_id) WHERE (NOT pre_registration);
CREATE INDEX IF NOT EXISTS money_events_pass ON money_events USING btree (pass_through) WHERE (NOT pre_registration);
CREATE INDEX IF NOT EXISTS money_events_rail ON money_events USING btree (rail, block_time DESC);
CREATE INDEX IF NOT EXISTS money_events_time ON money_events USING btree (block_time DESC);
CREATE INDEX IF NOT EXISTS money_events_to_pay ON money_events USING btree (to_id, block_time) WHERE (kind = 'PAY'::text);
CREATE UNIQUE INDEX IF NOT EXISTS money_events_tx_log ON money_events USING btree (tx, log_index, kind) WHERE (log_index IS NOT NULL);
CREATE INDEX IF NOT EXISTS probes_actor ON probes USING btree (actor_id, at DESC);
CREATE INDEX IF NOT EXISTS probes_at ON probes USING btree (at DESC);
CREATE INDEX IF NOT EXISTS registrations_minted ON registrations USING btree (minted_at);
