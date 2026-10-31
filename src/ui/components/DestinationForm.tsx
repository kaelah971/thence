"use client";

import { useState, type FormEvent } from "react";
import type { RouteId } from "@/domain/routes";
import { DEFAULT_DESTINATION, destinationAddressIssue, destinationFor } from "@/ui/lib/assets";
import { canSaveNetwork } from "@/ui/lib/recipients-api";
import { Button } from "./Button";
import { DestinationPicker } from "./DestinationPicker";
import { Notice, TextField } from "./primitives";
import styles from "./picker.module.css";

export interface DestinationDraft {
  name: string;
  routeId: RouteId;
  address: string;
  makePreferred: boolean;
  /** Only when `offerSave` is on: the person asked to keep this recipient. */
  save: boolean;
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
  /** One-off payments: the name is optional and asked for after the address. */
  nameOptional?: boolean;
  /** Show the address field before the currency picker (default false). */
  addressFirst?: boolean;
  /** Offer an opt-in "Save this recipient" toggle (off by default). */
  offerSave?: boolean;
  /**
   * Pin the submit button above the iOS keyboard (F8.10). Only enable on
   * full-page flows with a paper backdrop (the Send flow); sheets and
   * dialogs keep their natural layout.
   */
  stickyCta?: boolean;
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
  nameOptional = false,
  addressFirst = false,
  offerSave = false,
  stickyCta = false,
}: DestinationFormProps): React.JSX.Element {
  const [name, setName] = useState(initial?.name ?? "");
  const [routeId, setRouteId] = useState<RouteId>(initial?.routeId ?? DEFAULT_DESTINATION);
  const [address, setAddress] = useState(initial?.address ?? "");
  const [makePreferred, setMakePreferred] = useState(true);
  const [save, setSave] = useState(false);
  const [touched, setTouched] = useState({ name: false, address: false });
  const [serverError, setServerError] = useState<FormError | null>(null);
  const [saving, setSaving] = useState(false);
  const destination = destinationFor(routeId);
  const saveMode = mode === "save";

  const lightning = destination.network === "Lightning";
  const wantsSave = offerSave && save && canSaveNetwork(destination.network);
  const nameRequired = withName && (!nameOptional || wantsSave);
  const nameIssue = nameRequired && !name.trim() ? (wantsSave ? "Add a name to save this recipient." : "Add a name so you know who this is.") : null;
  const addressIssue = withAddress ? destinationAddressIssue(destination.network, address) : null;
  const nameError = (touched.name ? nameIssue : null) ?? (serverError?.field === "name" ? serverError.message : null);
  const addressError = (touched.address ? addressIssue : null) ?? (serverError?.field === "address" ? serverError.message : null);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setTouched({ name: true, address: true });
    if (blockedReason || saving || nameIssue || addressIssue) return;
    setSaving(true);
    setServerError(null);
    try {
      const error = await onSubmit({ name: name.trim(), routeId, address: address.trim(), makePreferred, save: wantsSave });
      if (error) setServerError(error);
    } finally {
      setSaving(false);
    }
  };

  const pickerField = (
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
  );
  // Inline confirmation copy (F8.10): validated live, shown once an entry
  // looks structurally valid. Never claims the address is the *right*
  // recipient — the user must still inspect it before continuing.
  const addressHint =
    !withAddress || addressIssue || address.trim().length === 0
      ? `Paste the ${destination.asset} address they gave you. Double-check it's for ${destination.network}.`
      : `Looks like a valid ${destination.network} address. Double-check it matches their wallet.`;
  const addressField = (
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
      // "go" is the closest valid enterKeyHint to the Continue CTA.
      enterKeyHint="go"
      error={addressError}
      hint={addressHint}
      inputClassName={styles.mono}
    />
  );
  const nameField = (
    <TextField
      label={nameRequired ? "Their name" : "Their name (optional)"}
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
      hint={nameRequired ? "So you recognise them next time." : "Shown on your receipt. Leave it empty if you like."}
    />
  );

  return (
    <form className={styles.form} onSubmit={(event) => void submit(event)} noValidate>
      {withName && !nameOptional && nameField}
      {withAddress && (addressFirst ? (
        <>
          {addressField}
          {pickerField}
        </>
      ) : (
        <>
          {pickerField}
          {addressField}
        </>
      ))}
      {withName && nameOptional && nameField}
      {offerSave && (
        <label className={styles.checkRow} data-disabled={!canSaveNetwork(destination.network) || undefined}>
          <input
            type="checkbox"
            checked={wantsSave}
            disabled={!canSaveNetwork(destination.network)}
            onChange={(event) => {
              setSave(event.target.checked);
              setServerError(null);
            }}
          />
          <span className={styles.checkText}>
            <span>Save this recipient</span>
            <span className={styles.checkHint}>
              {canSaveNetwork(destination.network) ? "Optional. Find them in Recipients next time." : "Lightning wallets can't be saved yet. You can still pay."}
            </span>
          </span>
        </label>
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
      <div className={stickyCta ? styles.stickyCta : undefined}>
        <Button
          type="submit"
          variant="ink"
          block
          disabled={Boolean(blockedReason) || saving}
          aria-busy={saving}
          trailingIcon={blockedReason || saving ? undefined : "arrow-right"}
        >
          {saving ? (wantsSave ? "Saving…" : "Checking…") : wantsSave ? "Save and continue" : submitLabel}
        </Button>
      </div>
    </form>
  );
}
