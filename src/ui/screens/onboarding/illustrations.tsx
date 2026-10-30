import { Icon } from "@/ui/components/Icon";
import { AssetMark, CardDuo } from "@/ui/components/PaymentCard";
import { Avatar, IllustrationTag } from "@/ui/components/primitives";
import styles from "./onboarding.module.css";

interface ArtProps {
  active: boolean;
}

/** Concept art only: no balances, rates or real payments. */
export function MoneyArt({ active }: ArtProps): React.JSX.Element {
  return (
    <div className={styles.art} data-active={active}>
      <span className={styles.halo} aria-hidden="true" />
      <svg className={styles.orbits} viewBox="0 0 360 360" aria-hidden="true">
        <ellipse cx="180" cy="190" rx="168" ry="92" transform="rotate(-16 180 190)" />
        <ellipse cx="180" cy="190" rx="120" ry="150" transform="rotate(28 180 190)" />
      </svg>
      <div className={styles.moneyStack}>
        <CardDuo
          key={active ? "on" : "off"}
          size="hero"
          label="Illustration: your NIM card in front of a USDT card. Note: you approve every payment; your NIM stays in Nimiq Pay until you do."
          note={
            <span className={styles.infoNote}>
              <span className={styles.infoIcon}>
                <Icon name="shield" size={16} strokeWidth={2.2} />
              </span>
              <span className={styles.infoText}>
                <strong>You approve every payment</strong>
                <span>Your NIM stays in Nimiq Pay until you do.</span>
              </span>
            </span>
          }
        />
      </div>
      <div className={styles.artTag}>
        <IllustrationTag />
      </div>
    </div>
  );
}

export function PeopleArt({ active }: ArtProps): React.JSX.Element {
  return (
    <div className={styles.art} data-active={active} role="img" aria-label="Illustration: three people. Example: Alex receives 25 USDC on Polygon.">
      <span className={styles.halo} aria-hidden="true" />
      <div className={styles.people} aria-hidden="true">
        <span className={styles.person} style={{ ["--i" as string]: 0 }}>
          <Avatar name="Mina Okafor" tone="sky" size={60} />
          <span>Mina</span>
        </span>
        <span className={`${styles.person} ${styles.personMain}`} style={{ ["--i" as string]: 1 }}>
          <Avatar name="Alex Moreno" tone="mint" size={84} />
          <span>Alex</span>
        </span>
        <span className={styles.person} style={{ ["--i" as string]: 2 }}>
          <Avatar name="Joon Park" tone="sun" size={60} />
          <span>Joon</span>
        </span>
      </div>
      <div className={styles.receiveCard} aria-hidden="true">
        <div className={styles.receiveTop}>
          <Avatar name="Alex Moreno" tone="mint" size={32} />
          <span className={styles.receiveWho}>Alex receives</span>
          <span className={styles.exampleTag}>Example</span>
        </div>
        <p className={styles.receiveAmount}>
          25 <span>USDC</span>
        </p>
        <p className={styles.receiveNet}>
          <AssetMark asset="USDC" size={16} />
          on Polygon
        </p>
      </div>
    </div>
  );
}

const TRUST_STEPS = ["Approved", "On its way", "Delivered"] as const;

export function TrustArt({ active }: ArtProps): React.JSX.Element {
  return (
    <div className={styles.art} data-active={active} role="img" aria-label="Illustration: a payment moving from Approved, to On its way, to Delivered, with a receipt.">
      <span className={`${styles.halo} ${styles.haloGreen}`} aria-hidden="true" />
      <div className={styles.trust} aria-hidden="true">
        <ol className={styles.path}>
          {TRUST_STEPS.map((label, i) => (
            <li key={label} style={{ ["--i" as string]: i }} data-last={i === TRUST_STEPS.length - 1}>
              <span className={styles.pathNode}>
                <Icon name="check" size={14} strokeWidth={3} />
              </span>
              <span className={styles.pathLabel}>{label}</span>
            </li>
          ))}
        </ol>
        <div className={styles.receipt}>
          <div className={styles.receiptHead}>
            <Icon name="receipt" size={16} />
            <span>Receipt</span>
            <span className={styles.exampleTag}>Example</span>
          </div>
          <dl className={styles.receiptRows}>
            <div>
              <dt>They received</dt>
              <dd>25 USDC</dd>
            </div>
            <div>
              <dt>Network</dt>
              <dd>Polygon</dd>
            </div>
            <div>
              <dt>Proof</dt>
              <dd className={styles.receiptBars}>
                <span />
                <span />
              </dd>
            </div>
          </dl>
        </div>
      </div>
      <div className={styles.artTag}>
        <IllustrationTag />
      </div>
    </div>
  );
}
