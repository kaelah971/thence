"use client";

import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import type { RouteId } from "@/domain/routes";
import { AddressDisplay } from "@/ui/components/AddressDisplay";
import { Button, ButtonLink } from "@/ui/components/Button";
import { DestinationPicker } from "@/ui/components/DestinationPicker";
import { Icon } from "@/ui/components/Icon";
import { AssetMark } from "@/ui/components/PaymentCard";
import { Avatar, EmptyState, Notice, PreviewTag } from "@/ui/components/primitives";
import { ActivityRow, RowSkeletons } from "@/ui/components/rows";
import { Sheet } from "@/ui/components/Sheet";
import { WalletCards } from "@/ui/components/WalletCards";
import shell from "@/ui/components/shell.module.css";
import { DEFAULT_DESTINATION, destinationFor } from "@/ui/lib/assets";
import { readChainBalanceFromApi, useNimBalance, type BalanceState } from "@/ui/lib/balance";
import { getHostNetwork } from "@nimiq/mini-app-sdk";
import { getHostProvider } from "@/ui/lib/nimiq-provider";
import {
  diagnoseSignedWallet,
  guidanceForSigned,
  listOtherWallets,
  type OtherWalletsResult,
  type SignedWalletDiagnosis,
} from "@/ui/lib/wallet-diagnostics";
import { formatLuna } from "@/ui/lib/luna";
import { useActivityData } from "@/ui/lib/data";
import { signOutEverywhere, useSession } from "@/ui/lib/session";
import { usePreviewMode, useSetupName } from "@/ui/lib/stores";
import { useWallet } from "@/ui/lib/wallet";
import styles from "./home.module.css";

export function Home(): React.JSX.Element {
  const router = useRouter();
  const session = useSession();
  const wallet = useWallet();
  const preview = usePreviewMode();
  const setupName = useSetupName();
  const [routeId, setRouteId] = useState<RouteId>(DEFAULT_DESTINATION);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const activity = useActivityData();
  const destination = destinationFor(routeId);
  const address = wallet.status === "connected" ? wallet.address : null;
  const balance = useNimBalance(address);
  const name = session.status === "valid" ? session.me.profile.displayName : preview ? setupName : null;

  const signOut = async () => {
    setSigningOut(true);
    await signOutEverywhere();
    setAccountOpen(false);
    router.replace("/app");
  };

  return (
    <main className={shell.screen}>
      <section className={shell.darkTop}>
        <span className={shell.glow} aria-hidden="true" />
        <header className={styles.header}>
          {address ? (
            <button type="button" className={styles.hello} onClick={() => setAccountOpen(true)} aria-haspopup="dialog" aria-label={`${name ? `Hello ${name}. ` : ""}Show wallet details`}>
              <Avatar name={name || "Thence"} tone="ink" size={44} />
              <HelloText name={name} />
            </button>
          ) : (
            <span className={styles.hello}>
              <Avatar name={name || "Thence"} tone="ink" size={44} />
              <HelloText name={name} />
            </span>
          )}
        </header>

        <div className={styles.stack}>
          <WalletCards wallet={wallet} balance={balance.state} onRetryBalance={balance.retry} onOpenAccount={() => setAccountOpen(true)} />
        </div>

        <nav className={styles.actions} aria-label="Quick actions">
          <ButtonLink href="/app/send" variant="light" size="md" icon="arrow-up-right">
            Send
          </ButtonLink>
          <ButtonLink href="/app/send?mode=request" variant="dark" size="md" icon="arrow-down-left">
            Request
          </ButtonLink>
          <ButtonLink href="/app/recipients" variant="dark" size="md" icon="users">
            Recipients
          </ButtonLink>
        </nav>
      </section>

      <section className={`${shell.paper} th-light`}>
        <span className={shell.paperHandle} aria-hidden="true" />

        <div className={styles.sendAs}>
          <div className={styles.sendAsRow}>
            <div>
              <p className={styles.sendAsLabel}>Send value as</p>
              <button type="button" className={styles.sendAsButton} onClick={() => setPickerOpen(true)} aria-haspopup="dialog">
                <AssetMark asset={destination.asset} size={24} />
                <span>{destination.label}</span>
                <Icon name="chevron-down" size={16} strokeWidth={2.4} />
              </button>
            </div>
            <div className={styles.estimate}>
              <p className={styles.estimateValue}>Estimate unavailable</p>
            </div>
          </div>
          <p className={styles.estimateHint}>
            <Icon name="info" size={14} />
            {address
              ? "No live conversion is available yet, so Thence won't guess. An estimate is never a balance you own."
              : "Connect your wallet to see what your NIM could send as. It's an estimate, not a balance you own."}
          </p>
        </div>

        <div className={shell.sectionHead}>
          <h2 className={shell.sectionTitle}>
            Recent activity {activity.status === "ready" && activity.preview && <PreviewTag />}
          </h2>
          {activity.status === "ready" && activity.items.length > 0 && (
            <Link href="/app/activity" className={shell.sectionLink}>
              See all
            </Link>
          )}
        </div>

        {activity.status === "loading" && <RowSkeletons count={3} />}
        {(activity.status === "disconnected" || (activity.status === "ready" && activity.items.length === 0)) && (
          <EmptyState
            icon="receipt"
            title="No payments yet"
            body="When you pay someone, you'll follow it here until it's delivered."
            action={
              <ButtonLink href="/app/send" variant="ink" size="md" icon="arrow-up-right">
                Send money
              </ButtonLink>
            }
          />
        )}
        {activity.status === "ready" && activity.items.length > 0 && (
          <div>
            {activity.items.slice(0, 3).map((item) => (
              <ActivityRow key={item.id} item={item} />
            ))}
          </div>
        )}
      </section>

      <Sheet open={pickerOpen} onClose={() => setPickerOpen(false)} title="Send value as">
        <DestinationPicker
          label="Choose what to estimate your NIM in"
          value={routeId}
          onChange={(next) => {
            setRouteId(next);
            setPickerOpen(false);
          }}
          hint="Only a preview of how your NIM could be sent. Live availability and estimates arrive in a later update."
        />
      </Sheet>

      <Sheet open={accountOpen} onClose={() => setAccountOpen(false)} title="Your wallet">
        {address && (
          <div className={styles.account}>
            <p className={styles.accountStatus}>
              <span className={styles.connectionDot} aria-hidden="true" />
              Connected with Nimiq Pay
            </p>
            <AddressDisplay address={address} />
            <p className={styles.accountNote}>
              This is the address you signed in with. Nimiq Pay chooses which wallet signs and pays.
            </p>
            <p className={styles.accountNote}>{balanceSourceNote(balance.state)}</p>
            <WalletDiagnostics address={address} />
            <Button variant="soft" block icon="close" onClick={() => void signOut()} disabled={signingOut} aria-busy={signingOut}>
              {signingOut ? "Signing out…" : "Sign out of Thence"}
            </Button>
          </div>
        )}
      </Sheet>
    </main>
  );
}

function HelloText({ name }: { name: string | null | undefined }): React.JSX.Element {
  return (
    <span className={styles.helloText}>
      <span className={styles.helloSmall}>{name ? "Hello," : "Welcome to"}</span>
      <span className={styles.helloName}>{name || "Thence"}</span>
    </span>
  );
}

/**
 * F7.3 — read-only wallet diagnostics in the account sheet.
 * Phase 1 compares both balance sources for the signed-in wallet (no
 * account listing). Phase 2 lists other host wallets ONLY after the user
 * explicitly asks. Masked identities only; never changes the session.
 */
function WalletDiagnostics({ address }: { address: string }): React.JSX.Element {
  const [phase, setPhase] = useState<"idle" | "checking" | "done">("idle");
  const [signed, setSigned] = useState<SignedWalletDiagnosis | null>(null);
  const [othersPhase, setOthersPhase] = useState<"idle" | "checking" | "done">("idle");
  const [others, setOthers] = useState<OtherWalletsResult | null>(null);

  const check = async () => {
    if (phase === "checking") return;
    setPhase("checking");
    try {
      const result = await diagnoseSignedWallet({
        getProvider: getHostProvider,
        readChain: readChainBalanceFromApi,
        getHostNetwork: typeof getHostNetwork === "function" ? getHostNetwork : undefined,
        sessionAddress: address,
      });
      setSigned(result);
    } catch {
      setSigned(null);
    } finally {
      setPhase("done");
    }
  };

  const listOthers = async () => {
    if (othersPhase === "checking") return;
    setOthersPhase("checking");
    try {
      setOthers(await listOtherWallets({ getProvider: getHostProvider, sessionAddress: address }));
    } catch {
      setOthers({ state: "failed", sessionInHost: null, others: [] });
    } finally {
      setOthersPhase("done");
    }
  };

  if (phase === "idle") {
    return (
      <div>
        <Button variant="soft" block icon="info" onClick={() => void check()}>
          Check this wallet on both sources
        </Button>
        <p className={styles.accountNote}>Compares Nimiq Pay with the confirmed network balance — nothing moves.</p>
      </div>
    );
  }

  if (phase === "checking" && !signed) {
    return (
      <Notice tone="info" title="Checking this wallet…">
        Reading Nimiq Pay and the confirmed network balance. Nothing moves.
      </Notice>
    );
  }

  if (!signed) {
    return (
      <div>
        <Notice tone="error" title="Couldn't check this wallet">
          The check didn&apos;t finish. Try again — nothing moved.
        </Notice>
        <Button variant="soft" size="sm" icon="refresh" onClick={() => void check()}>
          Try again
        </Button>
      </div>
    );
  }

  const guidance = guidanceForSigned(signed);
  const networkLabel = signed.hostNetwork === "mainnet" ? "Mainnet" : signed.hostNetwork === "testnet" ? "Testnet" : "Unknown network";
  const fundedOthers = (others?.others ?? []).filter((e) => e.luna !== null && e.luna > 0n);

  return (
    <div>
      <p className={styles.accountNote}>
        Nimiq Pay network: {networkLabel} · Server network: {signed.chain.network ?? "unavailable"}.
      </p>
      <p className={styles.accountNote}>
        Nimiq Pay: {signed.host.state === "loaded" ? `${formatLuna(signed.host.luna!).text} NIM` : signed.host.state}. Server:{" "}
        {signed.chain.state === "loaded" ? `${formatLuna(signed.chain.luna!).text} NIM` : signed.chain.state}.
      </p>
      {guidance === "funds-confirmed" && (
        <Notice tone="info" title="Funds confirmed">
          Both sources agree this wallet holds funds on the read networks.
        </Notice>
      )}
      {guidance === "host-chain-disagree" && (
        <Notice tone="warn" title="Sources disagree for this wallet">
          Nimiq Pay and the server see different balances for the signed-in wallet. This happens when the host is on a
          different network, the host hasn&apos;t synced yet, or funds moved recently. Compare the two lines above —
          neither is used to move money.
        </Notice>
      )}
      {guidance === "empty-on-read-networks" && (
        <Notice tone="info" title="This wallet reads empty on both sources">
          The signed-in wallet shows 0 NIM in Nimiq Pay and 0 NIM confirmed on the server network. If your funds are
          in a different Nimiq Pay wallet, list it below, then switch to it in Nimiq Pay and reconnect.
        </Notice>
      )}
      {guidance === "no-readable-source" && (
        <Notice tone="warn" title="No balance source is readable">
          Nimiq Pay can&apos;t share a balance here and the server lookup isn&apos;t available. Update Nimiq Pay and try
          again.
        </Notice>
      )}
      {guidance === "read-error" && (
        <Notice tone="error" title="Couldn't read a balance source">
          A lookup failed. A failed lookup is never shown as zero — try again.
        </Notice>
      )}
      {othersPhase === "idle" && (
        <div>
          <Button variant="soft" block icon="users" onClick={() => void listOthers()}>
            List my other Nimiq Pay wallets
          </Button>
          <p className={styles.accountNote}>Only with your permission. Shows masked identities and balances.</p>
        </div>
      )}
      {othersPhase === "checking" && !others && (
        <Notice tone="info" title="Listing wallets…">
          Asking Nimiq Pay for its wallet list. Nothing moves.
        </Notice>
      )}
      {others && others.state === "ready" && (
        <div>
          <p className={styles.accountNote}>
            {others.others.length} other wallet{others.others.length === 1 ? "" : "s"} in Nimiq Pay.
            {others.sessionInHost === false && " The signed-in wallet isn't in that list — reconnect after switching wallets."}
          </p>
          {fundedOthers.length > 0 && (
            <Notice tone="warn" title="Funds found in another wallet">
              {fundedOthers.map((e) => `${e.masked}: ${formatLuna(e.luna!).text} NIM`).join(", ")}.
              Switch to that wallet in Nimiq Pay, then reconnect and sign with it. Thence never switches wallets by
              itself.
            </Notice>
          )}
          {others.others.map((e) => (
            <p key={e.key} className={styles.accountNote}>
              {e.masked}: {e.luna !== null ? `${formatLuna(e.luna).text} NIM` : e.error ?? "unreadable"}
            </p>
          ))}
        </div>
      )}
      {others && others.state !== "ready" && (
        <Notice tone={others.state === "unsupported" ? "warn" : "error"} title="Couldn't list other wallets">
          {others.state === "unsupported"
            ? "This Nimiq Pay version can't list wallets. Update Nimiq Pay to compare wallets."
            : "The wallet list couldn't be read. Try again — nothing moved."}
        </Notice>
      )}
      <p className={styles.accountNote}>
        <Link href="/app/reconnect">Reconnect with a different wallet</Link>
      </p>
      <Button variant="soft" size="sm" icon="refresh" onClick={() => void check()}>
        Check again
      </Button>
    </div>
  );
}

function balanceSourceNote(state: BalanceState): string {
  switch (state.status) {
    case "loaded":
      return state.source === "host"
        ? "Your balance comes straight from Nimiq Pay."
        : "Your balance is the confirmed amount on the Nimiq network. Payments still waiting to confirm may not show yet.";
    case "loading":
      return "Loading your balance…";
    case "unavailable":
      return state.reason === "host-outdated"
        ? "This version of Nimiq Pay can't share your balance, and Thence couldn't read it from the Nimiq network."
        : state.reason === "network-mismatch"
          ? "Nimiq Pay is on a different Nimiq network than Thence, so no balance is shown."
          : "Open Thence inside Nimiq Pay to see your balance.";
    case "error":
      return "Thence couldn't load your balance right now. Your funds aren't affected.";
    case "disconnected":
      return "";
  }
}
