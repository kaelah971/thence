"use client";

import { useRouter } from "next/navigation";
import { IconButton } from "@/ui/components/Button";
import { CardStack } from "@/ui/components/PaymentCard";
import { useSetupName } from "@/ui/lib/stores";
import { ConnectWallet } from "./ConnectWallet";
import { useRedirectWhenSignedIn } from "./useRedirectWhenSignedIn";
import styles from "../screens.module.css";

export function WalletSetup(): React.JSX.Element {
  const router = useRouter();
  const name = useSetupName();
  useRedirectWhenSignedIn();
  return (
    <main className={styles.setup}>
      <header className={styles.setupTop}>
        <IconButton icon="arrow-left" label="Back to your name" onClick={() => router.push("/app/setup/name")} />
        <p className={styles.stepLabel}>Step 2 of 2</p>
        <span className={styles.topSpacer} aria-hidden="true" />
      </header>
      <div className={styles.walletArt}>
        <CardStack size="compact" routeId="usdc-polygon" label="Illustration: your NIM card" />
      </div>
      <section className={`${styles.setupSheet} ${styles.setupSheetShort} th-light`}>
        <div className={styles.setupIntro}>
          <h1 className={styles.setupTitle}>
            {name ? `One last thing, ${name}. Your wallet.` : "One last thing. Your wallet."}
          </h1>
          <p className={styles.setupBody}>Connect your Nimiq wallet to start sending and tracking payments.</p>
        </div>
        <ConnectWallet />
      </section>
    </main>
  );
}
