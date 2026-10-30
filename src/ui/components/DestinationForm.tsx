"use client";

import { useState, type FormEvent } from "react";
import type { RouteId } from "@/domain/routes";
import { DEFAULT_DESTINATION, destinationAddressIssue, destinationFor } from "@/ui/lib/assets";
import { Button } from "./Button";
import { DestinationPicker } from "./DestinationPicker";
import { Notice, TextField } from "./primitives";
import styles from "./picker.module.css";

export interface DestinationDraft {
  name: string;
  routeId: RouteId;
  address: string;
  makePreferred: boolean;
}

export interface FormError {
  field: "name" | "address" | "form";
  message: string;
}

interface DestinationFormProps {
  submitLabel: string;
  /** Return an error to show it next to the field; null/void when handled. */
  onSubmit: (draft: DestinationDraft) => Promise<FormError | null | void> | FormError | null | void;
  /** "save" stores a receiving wallet; "pay" is a one-off destination. */
  mode?: "pay" | "save";
  withName?: boolean;
  withAddress?: boolean;
  offerPreferred?: boolean;
  initial?: Partial<Omit<DestinationDraft, "makePreferred">>;
  /** When set, the form validates but cannot submit, and explains why. */
  blockedReason?: string | undefined;
}

export function DestinationForm({
  submitLabel,
  onSubmit,
  mode = "pay",
  withName = true,
  withAddress = true,
  offerPreferred = false,
  initial,
  blockedReason,
}: DestinationFormProps): React.JSX.Element {
  const [name, setName] = useState(initial?.name ?? "");
  const [routeId, setRouteId] = useState<RouteId>(initial?.routeId ?? DEFAULT_DESTINATION);
  const [address, setAddress] = useState(initial?.address ?? "");
  const [makePreferred, setMakePreferred] = useState(true);
  const [touched, setTouched] = useState({ name: false, address: false });
  const [serverError, setServerError] = useState<FormError | null>(null);
  const [saving, setSaving] = useState(false);
  const destination = destinationFor(routeId);
  const saveMode = mode === "save";

  const nameIssue = withName && !name.trim() ? "Add a name so you know who this is." : null;
  const addressIssue = withAddress ? destinationAddressIssue(destination.network, address) : null;
  const nameError = (touched.name ? nameIssue : null) ?? (serverError?.field === "name" ? serverError.message : null);
  const addressError = (touched.address ? addressIssue : null) ?? (serverError?.field === "address" ? serverError.message : null);
  const lightning = destination.network === "Lightning";

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setTouched({ name: true, address: true });
    if (blockedReason || saving || nameIssue || addressIssue) return;
    setSaving(true);
    setServerError(null);
    try {
      const error = await onSubmit({ name: name.trim(), routeId, address: address.trim(), makePreferred });
      if (error) setServerError(error);
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className={styles.form} onSubmit={(event) => void submit(event)} noValidate>
      {withName && (
        <TextField
          label="Their name"
          value={name}
          onChange={(event) => {
            setName(event.target.value.slice(0, 120));
            setServerError(null);
          }}
          onBlur={() => setTouched((t) => ({ ...t, name: true }))}
          placeholder="e.g. Alex Moreno"
          autoComplete="off"
          autoCapitalize="words"
          error={nameError}
          hint="So you recognise them next time."
        />
      )}
      {withAddress && (
        <>
          <DestinationPicker
            label={saveMode ? "Preferred currency" : "They receive"}
            value={routeId}
            onChange={(next) => {
              setRouteId(next);
              setServerError(null);
            }}
            mode={mode}
            hint={saveMode ? "Choose the currency and network their wallet uses." : "Live availability is checked before you pay."}
          />
          <TextField
            label={lightning ? "Lightning address or invoice" : saveMode ? "Receiving wallet address" : `Their ${destination.network} address`}
            value={address}
            onChange={(event) => {
              setAddress(event.target.value);
              setServerError(null);
            }}
            onBlur={() => setTouched((t) => ({ ...t, address: true }))}
            placeholder={lightning ? "name@wallet.com" : "0x…"}
            autoComplete="off"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            inputMode={lightning ? "email" : "text"}
            error={addressError}
            hint={`Paste the ${destination.asset} address they gave you. Double-check it's for ${destination.network}.`}
            inputClassName={styles.mono}
          />
        </>
      )}
      {offerPreferred && (
        <label className={styles.checkRow}>
          <input type="checkbox" checked={makePreferred} onChange={(event) => setMakePreferred(event.target.checked)} />
          <span>Make this their preferred wallet</span>
        </label>
      )}
      {serverError?.field === "form" && (
        <Notice tone="error" icon="alert" live>
          {serverError.message}
        </Notice>
      )}
      {blockedReason && (
        <Notice tone="info" icon="lock">
          {blockedReason}
        </Notice>
      )}
      <Button
        type="submit"
        variant="ink"
        block
        disabled={Boolean(blockedReason) || saving}
        aria-busy={saving}
        trailingIcon={blockedReason || saving ? undefined : "arrow-right"}
      >
        {saving ? "Saving…" : submitLabel}
      </Button>
    </form>
  );
}
