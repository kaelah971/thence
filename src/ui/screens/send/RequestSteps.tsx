"use client";

import { useState, type FormEvent } from "react";
import type { RouteId } from "@/domain/routes";
import { Button, ButtonLink, IconButton } from "@/ui/components/Button";
import { Icon } from "@/ui/components/Icon";
import { AssetMark } from "@/ui/components/PaymentCard";
import picker from "@/ui/components/picker.module.css";
import { Notice, TextField } from "@/ui/components/primitives";
import { ShareLink } from "@/ui/components/ShareLink";
import { destinationAddressIssue, destinationFor, maskAddress } from "@/ui/lib/assets";
import { friendlyMessage } from "@/ui/lib/api";
import { formatFixed } from "@/ui/lib/calculator";
import { invalidateData } from "@/ui/lib/resource";
import { createPaymentRequest, formatRequestDate, requestFormError, type ApiOwnerRequest } from "@/ui/lib/requests-api";
import styles from "./send.module.css";

const NOTE_MAX = 280;

/** Step 2 of Request money: who you are, where you receive, an optional note. */
export function RequestDetailsStep({
  routeId,
  amount,
  decimals,
  defaultName,
  onBack,
  onCreated,
}: {
  routeId: RouteId;
  amount: string;
  decimals: number;
  defaultName: string;
  onBack: () => void;
  onCreated: (request: ApiOwnerRequest) => void;
}): React.JSX.Element {
  const destination = destinationFor(routeId);
  const [name, setName] = useState(defaultName);
  const [address, setAddress] = useState("");
  const [memo, setMemo] = useState("");
  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [serverError, setServerError] = useState<{ field: string; message: string } | null>(null);

  const nameIssue = name.trim() ? null : "Add the name the payer will see.";
  const addressIssue = destinationAddressIssue(destination.network, address);
  const nameError = (touched ? nameIssue : null) ?? (serverError?.field === "name" ? serverError.message : null);
  const addressError = (touched ? addressIssue : null) ?? (serverError?.field === "address" ? serverError.message : null);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setTouched(true);
    if (saving || nameIssue || addressIssue) return;
    setSaving(true);
    setServerError(null);
    const result = await createPaymentRequest({ recipientName: name, asset: destination.asset, network: destination.network, address, amount, memo });
    setSaving(false);
    if (result.ok) {
      invalidateData();
      onCreated(result.data.request);
      return;
    }
    if (result.kind === "aborted") return;
    setServerError(requestFormError(result.code) ?? { field: "form", message: friendlyMessage(result) });
  };

  return (
    <form className={styles.reviewStep} key="request-details" onSubmit={(event) => void submit(event)} noValidate>
      <header className={styles.sheetTop}>
        <IconButton icon="arrow-left" label="Back to amount" tone="light" onClick={onBack} />
        <h2 className={styles.sheetTitle}>Request details</h2>
        <span className={styles.topSpacer} aria-hidden="true" />
      </header>

      <div className={styles.reviewScroll}>
        <div className={styles.reviewHero}>
          <p className={styles.reviewWho}>You&apos;ll receive</p>
          <p className={styles.reviewAmount}>
            <span className="tabular">{formatFixed(amount, decimals)}</span> <span className={styles.reviewAsset}>{destination.asset}</span>
          </p>
          <p className={styles.reviewNet}>
            <AssetMark asset={destination.asset} size={18} /> on {destination.network}
          </p>
        </div>

        <div className={picker.form}>
          <TextField
            label="Your name"
            value={name}
            onChange={(event) => {
              setName(event.target.value.slice(0, 120));
              setServerError(null);
            }}
            autoComplete="name"
            autoCapitalize="words"
            error={nameError}
            hint="The person paying sees this name."
          />
          <TextField
            label={`Your ${destination.network} wallet address`}
            value={address}
            onChange={(event) => {
              setAddress(event.target.value);
              setServerError(null);
            }}
            placeholder="0x…"
            autoComplete="off"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            error={addressError}
            hint={`Where your ${destination.asset} arrives. Use a ${destination.network} wallet, not your Nimiq address.`}
            inputClassName={picker.mono}
          />
          <TextField
            label="Note (optional)"
            value={memo}
            onChange={(event) => setMemo(event.target.value.slice(0, NOTE_MAX))}
            placeholder="e.g. Dinner on Friday"
            autoComplete="off"
            hint="Visible to anyone with the link."
          />
          {serverError?.field === "form" && (
            <Notice tone="error" icon="alert" live>
              {serverError.message}
            </Notice>
          )}
          {serverError?.field === "amount" && (
            <Notice tone="error" icon="alert" live>
              {serverError.message}
            </Notice>
          )}
          <Notice tone="info" icon="lock">
            Once created, the amount and wallet can&apos;t be changed. You can cancel the request at any time.
          </Notice>
        </div>
      </div>

      <div className={styles.cta}>
        <Button type="submit" variant="ink" block disabled={saving} aria-busy={saving} trailingIcon={saving ? undefined : "arrow-right"}>
          {saving ? "Creating…" : "Create request"}
        </Button>
        <p className={styles.ctaNote}>
          <Icon name="shield" size={14} />
          Creating a request doesn&apos;t move any money.
        </p>
      </div>
    </form>
  );
}

/** Step 3: the request exists — share it. */
export function RequestSharedStep({ request, onDone }: { request: ApiOwnerRequest; onDone: () => void }): React.JSX.Element {
  const expires = formatRequestDate(request.expiresAt);
  const decimals = Math.max(2, (request.amount.split(".")[1] ?? "").length);
  return (
    <div className={styles.handoffStep} key="request-shared">
      <div className={styles.handoffScroll}>
        <div className={styles.handoffHero}>
          <span className={styles.requestMark}>
            <Icon name="link" size={34} strokeWidth={2.1} />
          </span>
          <h2 className={styles.handoffTitle}>Your request is ready</h2>
          <p className={styles.handoffBody}>
            Send the link to whoever is paying. They&apos;ll see exactly what to send and where.
          </p>
        </div>

        <div className={styles.sharedBody}>
          <ShareLink url={request.url} title={`Payment request from ${request.recipientName}`} />
  
          <dl className={styles.details}>
            <div>
              <dt>You receive</dt>
              <dd className="tabular">
                {formatFixed(request.amount, decimals)} {request.asset}
              </dd>
            </div>
            <div>
              <dt>Network</dt>
              <dd>{request.network}</dd>
            </div>
            <div>
              <dt>Your wallet</dt>
              <dd className={styles.mono}>{maskAddress(request.destination)}</dd>
            </div>
            {request.memo && (
              <div>
                <dt>Note</dt>
                <dd>{request.memo}</dd>
              </div>
            )}
            {expires && (
              <div>
                <dt>Link expires</dt>
                <dd>{expires}</dd>
              </div>
            )}
          </dl>
        </div>
      </div>

      <div className={styles.handoffActions}>
        <ButtonLink href="/app/requests" variant="soft">
          Your requests
        </ButtonLink>
        <Button variant="ink" onClick={onDone}>
          Done
        </Button>
      </div>
    </div>
  );
}
