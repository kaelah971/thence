"use client";

import { useRouter } from "next/navigation";
import { Button } from "@/ui/components/Button";
import { Notice } from "@/ui/components/primitives";
import { ThenceMark } from "@/ui/components/ThenceMark";
import { resetDeviceSetup, setPreviewMode, usePreviewMode } from "@/ui/lib/stores";
import styles from "./screens.module.css";

export function DevPreview(): React.JSX.Element {
  const router = useRouter();
  const preview = usePreviewMode();

  const open = (withFixtures: boolean, href: string) => {
    setPreviewMode(withFixtures);
    router.push(href);
  };

  return (
    <main className={styles.devPreview}>
      <ThenceMark size={30} />
      <div className={styles.devHead}>
        <p className={styles.devEyebrow}>Development preview · not available in production</p>
        <h1 className={styles.reconnectTitle}>Inspect the app without a wallet</h1>
        <p className={styles.reconnectCopy}>
          Preview data never signs in or calls authenticated APIs. It lets reviewers open the app shell with clearly labelled
          fictional people and payments.
        </p>
      </div>

      <Notice tone="dark" icon="eye" title={preview ? "Preview data is on" : "Preview data is off"}>
        Preview data is fictional, labelled on every screen and never sent to Thence.
      </Notice>

      <div className={styles.devActions}>
        <Button variant="mint" block onClick={() => open(true, "/app/home")} trailingIcon="arrow-right">
          Open app with preview data
        </Button>
        <Button variant="dark" block onClick={() => open(false, "/app")}>
          Open the real app (sign-in required)
        </Button>
        <Button
          variant="ghost"
          block
          onClick={() => {
            resetDeviceSetup();
            open(false, "/app");
          }}
        >
          Restart first-run tour
        </Button>
        <Button variant="ghost" block onClick={() => router.push("/app/reconnect")}>
          Show the returning-user screen
        </Button>
      </div>
    </main>
  );
}
