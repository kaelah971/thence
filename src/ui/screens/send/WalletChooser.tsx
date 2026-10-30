"use client";

import { useId, useState } from "react";
import type { RouteId } from "@/domain/routes";
import { Button } from "@/ui/components/Button";
import { Icon } from "@/ui/components/Icon";
import { AssetMark } from "@/ui/components/PaymentCard";
import picker from "@/ui/components/picker.module.css";
import { EmptyState, Skeleton } from "@/ui/components/primitives";
import { destinationFor, maskAddress } from "@/ui/lib/assets";
import { getRecipient, isWalletVerified, payableWallets } from "@/ui/lib/recipients-api";
import { useApiResource } from "@/ui/lib/resource";
import { availabilityFor, useRouteCatalogue } from "@/ui/lib/routes-api";
import { useSession } from "@/ui/lib/session";
import styles from "./send.module.css";

export interface ChosenWallet {
  destinationId: string;
  routeId: RouteId;
  address: string;
  verified: boolean;
}

/** Pick which of a person's saved receiving wallets to pay. Preferred is preselected. */
export function WalletChooser({
  recipientId,
  name,
  selectedId,
  onChoose,
}: {
  recipientId: string;
  name: string;
  selectedId: string | null;
  onChoose: (wallet: ChosenWallet) => void;
}): React.JSX.Element {
  const group = useId();
  const [picked, setPicked] = useState<string | null>(null);
  const session = useSession();
  const userId = session.status === "valid" ? session.me.user.id : null;
  const resource = useApiResource(userId ? `recipient:${userId}:${recipientId}` : null, (signal) => getRecipient(recipientId, { signal }));
  const routes = useRouteCatalogue();
  const catalogue = routes.status === "ready" ? routes.catalogue : null;

  if (resource.status === "error") {
    return (
      <EmptyState
        icon="alert"
        title="Couldn't load their wallets"
        body={resource.message}
        action={
          <Button variant="soft" size="md" icon="refresh" onClick={resource.retry}>
            Try again
          </Button>
        }
      />
    );
  }
  if (resource.status !== "ready") {
    return (
      <div className={picker.options} aria-busy="true">
        {[0, 1].map((i) => (
          <Skeleton key={i} width="100%" height={64} radius={18} />
        ))}
      </div>
    );
  }

  const wallets = payableWallets(resource.data.recipient.destinations);
  const current = picked ?? selectedId ?? wallets.find((w) => w.isDefault)?.id ?? wallets[0]?.id ?? null;
  const chosen = wallets.find((w) => w.id === current) ?? null;
  const chosenUnavailable = chosen ? availabilityFor(chosen.routeId, catalogue).availability === "unavailable" : true;

  if (wallets.length === 0) {
    return <EmptyState icon="wallet" title="No wallet to pay" body={`${name} has no receiving wallet that can be paid yet.`} />;
  }

  return (
    <div className={styles.walletChooser}>
      <fieldset className={picker.picker}>
        <legend className={picker.legend}>Where should {name} receive it?</legend>
        <div className={picker.options}>
          {wallets.map((w) => {
            const destination = destinationFor(w.routeId);
            const { availability, note } = availabilityFor(w.routeId, catalogue);
            const disabled = availability === "unavailable" && w.id !== current;
            const verified = isWalletVerified(w.verification);
            return (
              <label key={w.id} className={picker.option} data-unavailable={disabled}>
                <input
                  type="radio"
                  name={group}
                  className={picker.radio}
                  checked={w.id === current}
                  disabled={disabled}
                  onChange={() => setPicked(w.id)}
                />
                <AssetMark asset={destination.asset} size={32} />
                <span className={picker.text}>
                  <span className={picker.asset}>
                    {destination.sentence}
                    {w.isDefault && <span className={styles.walletPreferred}>Preferred</span>}
                  </span>
                  <span className={picker.network}>
                    <span className={styles.mono}>{maskAddress(w.address)}</span>
                    {verified ? " · Verified" : ""}
                    {routes.status === "loading" ? " · Checking availability…" : note ? ` · ${note}` : ""}
                  </span>
                </span>
                <span className={picker.check} aria-hidden="true">
                  <Icon name="check" size={14} strokeWidth={3} />
                </span>
              </label>
            );
          })}
        </div>
        <p className={picker.hint}>Only wallets that can receive right now can be chosen.</p>
      </fieldset>
      <Button
        variant="ink"
        block
        trailingIcon="arrow-right"
        disabled={!chosen || chosenUnavailable}
        onClick={() => chosen && onChoose({ destinationId: chosen.id, routeId: chosen.routeId, address: chosen.address, verified: isWalletVerified(chosen.verification) })}
      >
        Pay this wallet
      </Button>
    </div>
  );
}
