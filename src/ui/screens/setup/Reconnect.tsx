"use client";

import Link from "next/link";
import { CardStack } from "@/ui/components/PaymentCard";
import { ThenceMark } from "@/ui/components/ThenceMark";
import { useSetupName } from "@/ui/lib/stores";
import { ConnectWallet } from "./ConnectWallet";
import { useRedirectWhenSignedIn } from "./useRedirectWhenSignedIn";
import styles from "../screens.module.css";

/** Short return path: no tour, just reconnect. */
export function Reconnect(): React.JSX.Element {
  const name = useSetupName();
  useRedirectWhenSignedIn();
  return (
    <main className={styles.reconnect}>
      <span className={styles.reconnectGlow} aria-hidden="true" />
      <header className={styles.reconnectTop}>
        <ThenceMark size={30} />
      </header>
      <div className={styles.reconnectArt}>
        <CardStack size="compact" routeId="usdc-polygon" label="Illustration: your NIM card" />
      </div>
      <div className={styles.reconnectBody}>
        <h1 className={styles.reconnectTitle}>{name ? `Welcome back, ${name}.` : "Welcome back."}</h1>
        <p className={styles.reconnectCopy}>Connect your wallet to pick up where you left off.</p>
        <ConnectWallet tone="dark" />
        <Link href="/app/welcome" className={styles.reconnectAlt}>
          New to Thence? See the introduction
        </Link>
      </div>
    </main>
  );
}
