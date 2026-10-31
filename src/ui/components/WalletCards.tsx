"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";
import type { BalanceState } from "@/ui/lib/balance";
import { formatLuna, shortNimiqAddress } from "@/ui/lib/luna";
import type { WalletConnection } from "@/ui/lib/wallet";
import { Icon } from "./Icon";
import { CardIdentity, CardSurface, type WalletAsset } from "./PaymentCard";
import styles from "./cards.module.css";

interface WalletCardsProps {
  wallet: WalletConnection;
  balance: BalanceState;
  onRetryBalance: () => void;
  onOpenAccount: () => void;
}

const NETWORK_LABEL: Record<string, string> = { mainnet: "Mainnet", testnet: "Testnet" };

/**
 * F8.7 NIM card copy: clean consumer language on the card, full detail in
 * the account sheet. "Wallet balance" names the total without claiming
 * instant spendability (contract-held vault funds are not proven liquid).
 * The technical vault breakdown lives in the wallet details sheet, never
 * on the card.
 */
export const NIM_CARD_LABEL = "Wallet balance";
export const NIM_CARD_FOOT = "Connected through Nimiq Pay";

/** Pure card note: coverage warnings and honest empty/error states only. */
export function nimCardNote(balance: BalanceState): string | null {
  switch (balance.status) {
    case "loaded": {
      const parts: string[] = [];
      if (balance.vaultUnknown === true) {
        parts.push("Vault balance couldn't be fully confirmed — the total may be higher.");
      }
      if (formatLuna(balance.luna).isZero && balance.vaultUnknown !== true) {
        parts.push("This wallet has no NIM yet.");
      }
      return parts.length > 0 ? parts.join(" ") : null;
    }
    case "unavailable":
      if (balance.reason === "host-outdated") return "This version of Nimiq Pay can't share your balance yet.";
      if (balance.reason === "network-mismatch") return "Nimiq Pay is on a different network, so Thence won't show a balance.";
      return "Open Thence in Nimiq Pay to see your balance.";
    case "error":
      return balance.reason === "network" ? "Couldn't reach the Nimiq network." : "Couldn't load your balance.";
    default:
      return null;
  }
}

/**
 * Two-card wallet: NIM in front, USDT tucked behind. Tapping the exposed
 * card brings it forward. Every number shown is a real, retrieved value —
 * USDT has no readable balance in Thence today, and says so.
 */
export function WalletCards({ wallet, balance, onRetryBalance, onOpenAccount }: WalletCardsProps): React.JSX.Element {
  const [front, setFront] = useState<WalletAsset>("NIM");
  const [animate, setAnimate] = useState(false);
  const bring = (asset: WalletAsset) => {
    setAnimate(true);
    setFront(asset);
  };

  return (
    <section className={styles.deck} data-animate={animate} aria-label="Your wallet cards">
      <Slot asset="NIM" front={front} onBring={bring}>
        <NimFace wallet={wallet} balance={balance} isFront={front === "NIM"} onRetry={onRetryBalance} onOpenAccount={onOpenAccount} />
      </Slot>
      <Slot asset="USDT" front={front} onBring={bring}>
        <UsdtFace isFront={front === "USDT"} />
      </Slot>
      <p className="sr-only" aria-live="polite">
        {front === "NIM" ? "NIM card in front." : "USDT card in front."}
      </p>
    </section>
  );
}

function Slot({ asset, front, onBring, children }: { asset: WalletAsset; front: WalletAsset; onBring: (asset: WalletAsset) => void; children: ReactNode }): React.JSX.Element {
  const isFront = asset === front;
  return (
    <div className={styles.slot} data-pos={isFront ? "front" : "back"} data-asset={asset}>
      <div aria-hidden={!isFront} inert={!isFront}>
        {children}
      </div>
      {!isFront && (
        <button type="button" className={styles.reveal} onClick={() => onBring(asset)} aria-label={`Show your ${asset} card`} />
      )}
    </div>
  );
}

function PeekHint(): React.JSX.Element {
  return (
    <span className={styles.peekHint} aria-hidden="true">
      View
      <Icon name="arrow-up-right" size={16} strokeWidth={2.4} />
    </span>
  );
}

interface NimFaceProps {
  wallet: WalletConnection;
  balance: BalanceState;
  isFront: boolean;
  onRetry: () => void;
  onOpenAccount: () => void;
}

function NimFace({ wallet, balance, isFront, onRetry, onOpenAccount }: NimFaceProps): React.JSX.Element {
  const connected = wallet.status === "connected" ? wallet : null;
  const head = (
    <div className={styles.head}>
      <CardIdentity asset="NIM" sub="Nimiq" />
      {!isFront ? (
        <PeekHint />
      ) : connected ? (
        <button type="button" className={styles.chip} onClick={onOpenAccount} aria-haspopup="dialog" aria-label={`Wallet ${connected.address}. Show wallet details`}>
          {shortNimiqAddress(connected.address)}
          <Icon name="chevron-down" size={14} strokeWidth={2.4} />
        </button>
      ) : null}
    </div>
  );

  if (!connected) {
    const checking = wallet.status === "checking";
    const expired = wallet.status === "expired";
    return (
      <CardSurface asset="NIM">
        {head}
        <div className={styles.body} aria-busy={checking}>
          <p className={styles.label}>{NIM_CARD_LABEL}</p>
          {checking ? (
            <span className={styles.amount}>
              <span className={styles.skeleton} />
              <span className="sr-only">Checking your wallet…</span>
            </span>
          ) : (
            <p className={styles.note}>{expired ? "Your session ended. Reconnect to see your NIM balance." : "Connect your Nimiq wallet to see your NIM balance."}</p>
          )}
        </div>
        {!checking && (
          <div className={styles.foot}>
            <span>{NIM_CARD_FOOT}</span>
            <Link href={expired ? "/app/reconnect" : "/app/setup/wallet"} className={styles.connectLink}>
              {expired ? "Reconnect" : "Connect wallet"}
              <Icon name="arrow-right" size={16} strokeWidth={2.4} />
            </Link>
          </div>
        )}
      </CardSurface>
    );
  }

  const loaded = balance.status === "loaded" ? balance : null;
  const formatted = loaded ? formatLuna(loaded.luna) : null;
  const chars = formatted ? formatted.text.length + 3 : 8;
  // F8.7: card copy comes from the shared helper (tested, no technical vault text on the card).
  const note = nimCardNote(balance);
  const sourceLabel = NIM_CARD_FOOT;
  const network = loaded?.network ? NETWORK_LABEL[loaded.network] : null;

  return (
    <CardSurface asset="NIM">
      {head}
      <div className={styles.body} aria-busy={balance.status === "loading"} aria-live="polite">
        <p className={styles.label}>{NIM_CARD_LABEL}</p>
        {balance.status === "loading" ? (
          <span className={styles.amount}>
            <span className={styles.skeleton} />
            <span className="sr-only">Loading your balance…</span>
          </span>
        ) : formatted ? (
          <p className={styles.amount} style={{ ["--chars" as string]: chars }}>
            <span className="tabular">
              {formatted.whole}
              <span className={styles.amountFraction}>.{formatted.fraction}</span>
            </span>
            <span className={styles.amountUnit}>NIM</span>
          </p>
        ) : (
          <p className={styles.amount} data-muted="true">
            <span aria-hidden="true">—</span>
            <span className={styles.amountUnit}>NIM</span>
            <span className="sr-only">Balance unavailable</span>
          </p>
        )}
        {note && (
          <p className={styles.note}>
            {note}
            {balance.status === "error" && (
              <button type="button" className={styles.inlineAction} onClick={onRetry}>
                Try again
              </button>
            )}
          </p>
        )}
      </div>
      <div className={styles.foot}>
        <span>{sourceLabel}</span>
        {network && <span>{network}</span>}
      </div>
    </CardSurface>
  );
}

function UsdtFace({ isFront }: { isFront: boolean }): React.JSX.Element {
  return (
    <CardSurface asset="USDT">
      <div className={styles.head}>
        <CardIdentity asset="USDT" sub="Tether USD" />
        {!isFront && <PeekHint />}
      </div>
      <div className={styles.body}>
        <p className={styles.label}>Balance</p>
        <p className={styles.amount} data-muted="true">
          <span aria-hidden="true">—</span>
          <span className={styles.amountUnit}>USDT</span>
          <span className="sr-only">Balance unavailable</span>
        </p>
        <p className={styles.note}>Thence can&apos;t read USDT balances yet, so none is shown.</p>
      </div>
      <div className={styles.foot}>
        <span>You pay with NIM today</span>
      </div>
    </CardSurface>
  );
}
