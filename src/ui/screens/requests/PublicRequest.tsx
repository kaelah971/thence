"use client";

import { AddressDisplay } from "@/ui/components/AddressDisplay";
import { Button, ButtonLink } from "@/ui/components/Button";
import { Icon } from "@/ui/components/Icon";
import { AssetMark } from "@/ui/components/PaymentCard";
import { Avatar, EmptyState, Notice, Skeleton } from "@/ui/components/primitives";
import shell from "@/ui/components/shell.module.css";
import { ThenceMark } from "@/ui/components/ThenceMark";
import { destinationFor } from "@/ui/lib/assets";
import { cn } from "@/ui/lib/cn";
import { useApiResource } from "@/ui/lib/resource";
import { canPayRequest, formatRequestDate, getPublicRequest, isPublicId, payRequestHref, requestRouteId, type ApiPublicRequest } from "@/ui/lib/requests-api";
import { useSession } from "@/ui/lib/session";
import { ConnectWallet } from "@/ui/screens/setup/ConnectWallet";
import { formatRequestAmount, RequestPill } from "./Requests";
import styles from "./requests.module.css";

/**
 * Public payment-request link (/r/:publicId). Works without a session and
 * shows only the immutable public terms from the server — never the
 * requester's account or recipient book. Expired/cancelled requests are
 * shown as unpayable with their stored terms.
 */
export function PublicRequest({ publicId }: { publicId: string }): React.JSX.Element {
  const valid = isPublicId(publicId);
  const resource = useApiResource(valid ? `public-request:${publicId}` : null, (signal) => getPublicRequest(publicId, { signal }));
  const request = resource.status === "ready" ? resource.data.request : null;
  const notFound = !valid || (resource.status === "error" && /couldn't find|no longer exists/i.test(resource.message));

  return (
    <main className={shell.screen}>
      <section className={cn(shell.darkTop, styles.publicTop)}>
        <span className={shell.glow} aria-hidden="true" />
        <ThenceMark size={28} />
        {request ? (
          <div className={styles.publicHero}>
            <Avatar name={request.recipientName} tone="sand" size={64} />
            <p className={styles.publicWho}>{request.recipientName} is requesting</p>
            <p className={cn(styles.publicAmount, "tabular")}>{formatRequestAmount(request)}</p>
            <p className={styles.publicNet}>
              <RequestAsset request={request} /> on {request.network}
            </p>
            <RequestPill status={request.status} />
          </div>
        ) : (
          <div className={styles.publicHero} aria-busy={resource.status === "loading"}>
            <h1 className={shell.title}>Payment request</h1>
          </div>
        )}
      </section>

      <section className={`${shell.paper} th-light ${styles.publicPaper}`}>
        <span className={shell.paperHandle} aria-hidden="true" />
        {notFound ? (
          <EmptyState icon="link" title="Request not found" body="This link doesn't match a payment request. Check it with the person who sent it." />
        ) : resource.status === "error" ? (
          <EmptyState
            icon="alert"
            title="Couldn't open this request"
            body={resource.message}
            action={
              <Button variant="soft" size="md" icon="refresh" onClick={resource.retry}>
                Try again
              </Button>
            }
          />
        ) : request ? (
          <RequestTerms request={request} />
        ) : (
          <div className={styles.detail} aria-hidden="true">
            <Skeleton width="100%" height={180} radius={20} />
            <Skeleton width="100%" height={56} radius={28} />
          </div>
        )}
      </section>
    </main>
  );
}

function RequestAsset({ request }: { request: ApiPublicRequest }): React.JSX.Element | null {
  const routeId = requestRouteId(request);
  return routeId ? <AssetMark asset={destinationFor(routeId).asset} size={18} /> : null;
}

function RequestTerms({ request }: { request: ApiPublicRequest }): React.JSX.Element {
  const session = useSession();
  const payable = canPayRequest(request);
  const first = request.recipientName.split(/\s+/)[0] ?? request.recipientName;
  const expires = formatRequestDate(request.expiresAt);
  const signedIn = session.status === "valid";

  return (
    <div className={styles.detail}>
      <dl className={styles.facts}>
        <div>
          <dt>They receive</dt>
          <dd className="tabular">{formatRequestAmount(request)}</dd>
        </div>
        <div>
          <dt>Network</dt>
          <dd>{request.network}</dd>
        </div>
        {request.memo && (
          <div>
            <dt>Note</dt>
            <dd>{request.memo}</dd>
          </div>
        )}
        {expires && (
          <div>
            <dt>{request.status === "expired" ? "Expired" : request.status === "cancelled" ? "Was due to expire" : "Expires"}</dt>
            <dd>{expires}</dd>
          </div>
        )}
      </dl>

      <div className={styles.walletBox}>
        <p className={styles.walletLabel}>
          {first}&apos;s {request.network} wallet
        </p>
        <AddressDisplay address={request.destination} />
      </div>

      {request.status !== "active" ? (
        <Notice tone="info" icon="lock" title={request.status === "expired" ? "This request has expired" : "This request was cancelled"}>
          It can&apos;t be paid anymore. Ask {first} for a new link.
        </Notice>
      ) : !payable ? (
        <Notice tone="warn" icon="alert" title="Can't be paid right now">
          {request.asset} on {request.network} isn&apos;t available at the moment. Try again later.
        </Notice>
      ) : signedIn ? (
        <div className={styles.payArea}>
          <ButtonLink href={payRequestHref(request.publicId)} variant="ink" block trailingIcon="arrow-right">
            Pay {first}
          </ButtonLink>
          <p className={styles.payNote}>
            <Icon name="shield" size={14} />
            You&apos;ll see the live price before anything is sent. The amount and wallet can&apos;t be changed.
          </p>
        </div>
      ) : session.status === "unknown" ? (
        <Skeleton width="100%" height={56} radius={28} />
      ) : (
        <div className={styles.payArea}>
          <p className={styles.payIntro}>Sign in with Nimiq Pay to pay this request. Open this link inside Nimiq Pay if you&apos;re in another browser.</p>
          <ConnectWallet returnTo={payRequestHref(request.publicId)} />
        </div>
      )}
    </div>
  );
}
