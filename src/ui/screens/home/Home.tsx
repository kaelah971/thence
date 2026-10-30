"use client";

import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import type { RouteId } from "@/domain/routes";
import { AddressDisplay } from "@/ui/components/AddressDisplay";
import { Button, ButtonLink } from "@/ui/components/Button";
import { DestinationPicker } from "@/ui/components/DestinationPicker";
import { Icon } from "@/ui/components/Icon";
import { AssetMark, CardStack } from "@/ui/components/PaymentCard";
import { Avatar, EmptyState, PreviewTag } from "@/ui/components/primitives";
import { ActivityRow, RowSkeletons } from "@/ui/components/rows";
import { Sheet } from "@/ui/components/Sheet";
import shell from "@/ui/components/shell.module.css";
import { DEFAULT_DESTINATION, destinationFor } from "@/ui/lib/assets";
import { useNimBalance, type BalanceState } from "@/ui/lib/balance";
import { useActivityData } from "@/ui/lib/data";
import { formatLuna, shortNimiqAddress } from "@/ui/lib/luna";
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
          <span className={styles.hello}>
            <Avatar name={name || "Thence"} tone="ink" size={40} />
            <span className={styles.helloText}>
              <span className={styles.helloSmall}>{name ? "Hello" : "Welcome to"}</span>
              <span className={styles.helloName}>{name || "Thence"}</span>
            </span>
          </span>
          {wallet.status === "connected" ? (
            <button type="button" className={styles.connection} onClick={() => setAccountOpen(true)} aria-haspopup="dialog">
              <span className={styles.connectionDot} data-state="connected" aria-hidden="true" />
              Connected
            </button>
          ) : wallet.status === "checking" ? (
            <span className={styles.connection} aria-live="polite">
              <span className={styles.connectionDot} aria-hidden="true" />
              Checking…
            </span>
          ) : (
            <Link href={wallet.status === "expired" ? "/app/reconnect" : "/app/setup/wallet"} className={styles.connection}>
              <span className={styles.connectionDot} aria-hidden="true" />
              {wallet.status === "expired" ? "Reconnect" : "Not connected"}
            </Link>
          )}
        </header>

        <BalanceBlock state={balance.state} onRetry={balance.retry} />

        <CardStack
          size="home"
          routeId={routeId}
          label={`Your NIM card, sending value as ${destination.sentence}`}
          className={styles.stack}
          nimFooter={
            <span className={styles.cardStatus}>
              {address ? (
                shortNimiqAddress(address)
              ) : (
                <>
                  Wallet
                  <br />
                  not connected
                </>
              )}
            </span>
          }
        />

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
            <p className={styles.accountLabel}>Signed in with Nimiq Pay</p>
            <AddressDisplay address={address} />
            <p className={styles.accountNote}>
              This is the address you signed in with. Nimiq Pay chooses which wallet signs and pays.
            </p>
            <Button variant="soft" block icon="close" onClick={() => void signOut()} disabled={signingOut} aria-busy={signingOut}>
              {signingOut ? "Signing out…" : "Sign out of Thence"}
            </Button>
          </div>
        )}
      </Sheet>
    </main>
  );
}

function BalanceBlock({ state, onRetry }: { state: BalanceState; onRetry: () => void }): React.JSX.Element {
  const formatted = state.status === "loaded" ? formatLuna(state.luna) : null;
  const hint = (() => {
    switch (state.status) {
      case "loaded":
        return formatted?.isZero ? "This wallet has no NIM yet." : "Balance of the wallet you signed in with.";
      case "loading":
        return "Loading your balance…";
      case "unavailable":
        return state.reason === "host-outdated"
          ? "Update Nimiq Pay to see your balance here."
          : "Open Thence in Nimiq Pay to see your balance.";
      case "error":
        return state.reason === "network" ? "Couldn't reach the Nimiq network." : "Couldn't load your balance.";
      case "disconnected":
        return "Connect your wallet to see your NIM balance.";
    }
  })();

  return (
    <div className={styles.balance} aria-busy={state.status === "loading"}>
      <p className={styles.balanceLabel}>Available</p>
      <p className={styles.balanceValue} data-state={formatted ? "loaded" : undefined}>
        {formatted ? (
          <span className="tabular">
            {formatted.whole}
            <span className={styles.balanceFraction}>.{formatted.fraction}</span>
          </span>
        ) : (
          <span aria-hidden="true">—</span>
        )}
        <span className={styles.balanceUnit}>NIM</span>
        {!formatted && <span className="sr-only">Balance unavailable</span>}
      </p>
      <p className={styles.balanceHint} aria-live="polite">
        {hint}
        {state.status === "error" && (
          <>
            {" "}
            <button type="button" className={styles.balanceRetry} onClick={onRetry}>
              Try again
            </button>
          </>
        )}
      </p>
    </div>
  );
}
