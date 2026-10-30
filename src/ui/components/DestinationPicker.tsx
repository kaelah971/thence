"use client";

import { useId } from "react";
import type { RouteId } from "@/domain/routes";
import { destinationFor } from "@/ui/lib/assets";
import { canSaveNetwork } from "@/ui/lib/recipients-api";
import { ALL_ROUTES, availabilityFor, sortByAvailability, useRouteCatalogue } from "@/ui/lib/routes-api";
import { Icon } from "./Icon";
import { AssetMark } from "./PaymentCard";
import styles from "./picker.module.css";

interface DestinationPickerProps {
  label: string;
  value: RouteId;
  onChange: (routeId: RouteId) => void;
  hint?: string;
  /**
   * "pay": options the server reports as unavailable are disabled.
   * "save": any currency the server can save is selectable (a saved wallet
   * doesn't need to be payable today); unavailable ones are labelled.
   */
  mode?: "pay" | "save";
  /** Optional extra filter (e.g. requests can't use Lightning yet). */
  allow?: (routeId: RouteId) => boolean;
}

/** Native radio list. Availability comes only from GET /api/routes/public. */
export function DestinationPicker({ label, value, onChange, hint, mode = "pay", allow }: DestinationPickerProps): React.JSX.Element {
  const name = useId();
  const state = useRouteCatalogue();
  const catalogue = state.status === "ready" ? state.catalogue : null;
  const routes = sortByAvailability(
    ALL_ROUTES.filter((id) => (mode === "pay" || canSaveNetwork(destinationFor(id).network) || id === value) && (!allow || allow(id) || id === value)),
    catalogue,
  );

  return (
    <fieldset className={styles.picker}>
      <legend className={styles.legend}>{label}</legend>
      {state.status === "error" && (
        <p className={styles.catalogueError} role="status">
          We couldn&apos;t check which currencies are available right now.{" "}
          <button type="button" className={styles.inlineRetry} onClick={state.retry}>
            Try again
          </button>
        </p>
      )}
      <div className={styles.options} aria-busy={state.status === "loading"}>
        {routes.map((routeId) => {
          const destination = destinationFor(routeId);
          const { availability, note } = availabilityFor(routeId, catalogue);
          const disabled = mode === "pay" && availability === "unavailable" && routeId !== value;
          const shownNote =
            state.status === "loading"
              ? "Checking availability…"
              : mode === "save" && availability === "unavailable"
                ? "Can't be paid right now"
                : note;
          return (
            <label key={routeId} className={styles.option} data-unavailable={disabled}>
              <input
                type="radio"
                name={name}
                value={routeId}
                checked={routeId === value}
                onChange={() => onChange(routeId)}
                disabled={disabled}
                className={styles.radio}
              />
              <AssetMark asset={destination.asset} size={32} />
              <span className={styles.text}>
                <span className={styles.asset}>{destination.asset}</span>
                <span className={styles.network}>
                  on {destination.network}
                  {shownNote && ` · ${shownNote}`}
                </span>
              </span>
              <span className={styles.check} aria-hidden="true">
                <Icon name="check" size={14} strokeWidth={3} />
              </span>
            </label>
          );
        })}
      </div>
      {hint && <p className={styles.hint}>{hint}</p>}
    </fieldset>
  );
}
