import { Icon } from "@/ui/components/Icon";
import { HeroCards, MicroNote } from "@/ui/components/HeroCards";
import { AssetMark } from "@/ui/components/PaymentCard";
import { Avatar } from "@/ui/components/primitives";
import styles from "./onboarding.module.css";

interface ArtProps {
  active: boolean;
}

/** Concept art only: no balances, rates or real payments. */
export function MoneyArt({ active }: ArtProps): React.JSX.Element {
  return (
    <div className={styles.art} data-kind="hero" data-active={active}>
      <HeroCards
        key={active ? "on" : "off"}
        variant="hero"
        label="Your NIM card in front of a USDT card, with a note: you're in control, approve payments in Nimiq Pay."
        note={<MicroNote title="You're in control" body="Approve payments in Nimiq Pay" />}
      />
    </div>
  );
}

export function PeopleArt({ active }: ArtProps): React.JSX.Element {
  return (
    <div className={styles.art} data-active={active} role="img" aria-label="Three people. Example: Alex receives 25 USDC on Polygon.">
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
    <div className={styles.art} data-active={active} role="img" aria-label="A payment moving from Approved, to On its way, to Delivered, with a receipt.">
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
    </div>
  );
}
