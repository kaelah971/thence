import { getEnv } from "@/lib/env";
import { isPublicProofPublicationEnabled, listPublicProofs, publicProofConfig } from "@/lib/global-proofs";

export const dynamic = "force-dynamic";

const NIM_EXPLORER = "https://nimiq.watch/#";
const n = (atomic: string, decimals: number) => (Number(atomic) / 10 ** decimals).toLocaleString(undefined, { maximumFractionDigits: decimals });

/**
 * Public verification page. No wallet, no session: anyone can read every
 * delivered payment and check both transactions themselves.
 */
export default async function ProofsPage(): Promise<React.JSX.Element> {
  if (!isPublicProofPublicationEnabled()) {
    return <main style={page}><p>Public proof publication is not enabled.</p></main>;
  }
  const env = getEnv();
  const feed = await listPublicProofs({ limit: 100, cursor: null }, publicProofConfig({ routeTokens: env.THENCE_ROUTE_TOKENS_JSON, finalityPolicies: env.THENCE_SETTLEMENT_FINALITY_JSON }));
  const proofs = feed.proofs as unknown as Array<Record<string, any>>;

  return (
    <main style={page}>
      <header style={{ marginBottom: 20 }}>
        <p style={{ margin: 0, fontSize: 12, letterSpacing: ".08em", textTransform: "uppercase", color: "#5a6562" }}>Thence</p>
        <h1 style={{ margin: "6px 0 8px", fontFamily: "var(--font-display)", fontSize: 30 }}>Proof of payments</h1>
        <p style={{ margin: 0, color: "#5a6562", maxWidth: 560 }}>
          Every payment Thence delivered, with both transactions. Nothing here needs an account — open either hash in its explorer and compare
          the amount, the wallet and the block. A proof only appears after the payout is final on its chain.
        </p>
      </header>

      {proofs.length === 0 && <p style={{ color: "#5a6562" }}>No delivered payments yet.</p>}

      <ol style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: 12 }}>
        {proofs.map((p) => {
          const dest = p.destination ?? {};
          const src = p.source ?? {};
          const delivered = p.status === "DELIVERED";
          return (
            <li key={String(p.proofId)} style={card}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                <strong style={{ fontFamily: "var(--font-display)", fontSize: 20 }}>
                  {n(String(dest.verifiedAmountAtomic ?? "0"), Number(dest.decimals ?? 6))} {dest.asset ?? "USDC"} on {dest.network ?? "—"}
                </strong>
                <span style={{ ...pill, background: delivered ? "#dcf6e7" : "#fff3dc", color: delivered ? "#13a35b" : "#a8690c" }}>{p.status}</span>
              </div>
              <div style={{ display: "grid", gap: 6, marginTop: 12, fontSize: 13 }}>
                <Row label="They received">
                  <span style={{ fontFamily: "var(--font-mono, monospace)" }}>{dest.recipient}</span>
                </Row>
                <Row label="You sent">
                  {n(String(src.amountLuna ?? "0"), 5)} NIM
                </Row>
                <Row label="Payout tx">
                  <a href={dest.explorerTxUrl} target="_blank" rel="noopener noreferrer" style={link}>
                    {dest.transactionHash}
                  </a>
                </Row>
                <Row label="NIM tx">
                  <a href={`${NIM_EXPLORER}${src.transactionHash}`} target="_blank" rel="noopener noreferrer" style={link}>
                    {src.transactionHash}
                  </a>
                </Row>
                <Row label="Finality">
                  {dest.finalityLevel} · block {dest.blockNumber}
                </Row>
              </div>
            </li>
          );
        })}
      </ol>

      <p style={{ marginTop: 24, fontSize: 12, color: "#8b9592", maxWidth: 560 }}>
        Machine-readable JSON: <code style={{ fontSize: 12 }}>/api/proofs</code>. Source finality is a Nimiq macro block reported by the configured
        RPC; destination finality is the chain&apos;s own finalized block.
      </p>
    </main>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div style={{ display: "flex", gap: 12, alignItems: "baseline", flexWrap: "wrap" }}>
      <span style={{ color: "#8b9592", minWidth: 96, fontSize: 12 }}>{label}</span>
      <span style={{ overflowWrap: "anywhere" }}>{children}</span>
    </div>
  );
}

const page: React.CSSProperties = { maxWidth: 760, margin: "0 auto", padding: "32px 20px 64px", color: "#111614", background: "#f6f8f7", minHeight: "100vh" };
const card: React.CSSProperties = { background: "#fff", border: "1px solid #e4e9e7", borderRadius: 18, padding: 18 };
const pill: React.CSSProperties = { borderRadius: 99, padding: "4px 10px", fontSize: 12, fontWeight: 700, alignSelf: "center" };
const link: React.CSSProperties = { color: "#0b7a56", overflowWrap: "anywhere" };
