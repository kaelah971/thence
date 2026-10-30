"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Button, IconButton } from "@/ui/components/Button";
import { completeOnboarding } from "@/ui/lib/auth-client";
import { isOnboarded, setAuthenticated, useSession } from "@/ui/lib/session";
import { clearSetupName, NAME_MAX, saveSetupName, useSetupName } from "@/ui/lib/stores";
import styles from "../screens.module.css";

const browserFetch: typeof fetch = (...args) => fetch(...args);

/**
 * Before sign-in the name is kept temporarily in sessionStorage and saved
 * after the wallet connects. A signed-in account that hasn't finished
 * onboarding saves it straight to its profile. Completed profiles skip
 * this screen entirely.
 */
export function NameSetup(): React.JSX.Element {
  const router = useRouter();
  const stored = useSetupName();
  const session = useSession();
  const signedIn = session.status === "valid";
  const onboarded = isOnboarded(session);

  useEffect(() => {
    if (onboarded) router.replace("/app/home");
  }, [onboarded, router]);

  const ready = stored !== undefined && session.status !== "unknown" && !onboarded;

  return (
    <main className={styles.setup}>
      <header className={styles.setupTop}>
        {signedIn ? (
          <span className={styles.topSpacer} aria-hidden="true" />
        ) : (
          <IconButton icon="arrow-left" label="Back to the introduction" onClick={() => router.push("/app/welcome")} />
        )}
        <p className={styles.stepLabel}>{signedIn ? "Last step" : "Step 1 of 2"}</p>
        <span className={styles.topSpacer} aria-hidden="true" />
      </header>
      <section className={`${styles.setupSheet} th-light`}>
        {ready && (
          <NameForm
            initial={stored ?? ""}
            submitLabel={signedIn ? "Save and continue" : "Continue"}
            onSubmit={async (name) => {
              if (!signedIn) {
                saveSetupName(name);
                router.push("/app/setup/wallet");
                return null;
              }
              const result = await completeOnboarding(browserFetch, name);
              if (result.kind === "saved") {
                setAuthenticated(result.me);
                clearSetupName();
                router.replace("/app/home");
                return null;
              }
              if (result.kind === "unauthenticated") {
                saveSetupName(name);
                router.replace("/app/reconnect");
                return null;
              }
              return result.kind === "invalid" ? result.message : "Your name couldn't be saved. Check your connection and try again.";
            }}
          />
        )}
      </section>
    </main>
  );
}

interface NameFormProps {
  initial: string;
  submitLabel: string;
  /** Resolves to an error message, or null when handled. */
  onSubmit: (name: string) => Promise<string | null>;
}

function NameForm({ initial, submitLabel, onSubmit }: NameFormProps): React.JSX.Element {
  const [name, setName] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const trimmed = name.trim();
  const valid = trimmed.length > 0;

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!valid || saving) return;
    setSaving(true);
    setError(null);
    const message = await onSubmit(trimmed);
    setSaving(false);
    setError(message);
  };

  return (
    <form className={styles.setupForm} onSubmit={(event) => void submit(event)} noValidate>
      <div className={styles.setupIntro}>
        <h1 className={styles.setupTitle}>What should we call you?</h1>
        <p className={styles.setupBody}>Let&apos;s make Thence feel a little more personal.</p>
      </div>

      <div className={styles.nameField}>
        <label htmlFor="setup-name" className={styles.nameLabel}>
          Your name
        </label>
        <input
          id="setup-name"
          className={styles.nameInput}
          value={name}
          onChange={(event) => {
            setName(event.target.value.slice(0, NAME_MAX));
            setError(null);
          }}
          placeholder="e.g. Ada"
          autoComplete="nickname"
          autoCapitalize="words"
          enterKeyHint="next"
          maxLength={NAME_MAX}
          aria-describedby="setup-name-hint"
          aria-invalid={error ? true : undefined}
          autoFocus
        />
        <p id="setup-name-hint" className={error ? styles.nameError : styles.nameHint} role={error ? "alert" : undefined}>
          {error ?? (valid ? "A first name or nickname is perfect." : "Enter a name or nickname to continue.")}
        </p>
      </div>

      <div className={styles.setupActions}>
        <Button type="submit" variant="ink" block trailingIcon="arrow-right" disabled={!valid || saving} aria-busy={saving} aria-describedby="setup-name-hint">
          {saving ? "Saving…" : submitLabel}
        </Button>
      </div>
    </form>
  );
}
