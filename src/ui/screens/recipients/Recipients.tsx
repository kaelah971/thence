"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button, ButtonLink } from "@/ui/components/Button";
import { DestinationForm } from "@/ui/components/DestinationForm";
import { Icon } from "@/ui/components/Icon";
import { AssetMark } from "@/ui/components/PaymentCard";
import { AddressDisplay } from "@/ui/components/AddressDisplay";
import { Avatar, EmptyState, Notice, PreviewTag, SearchField, Segmented, Skeleton, TextField } from "@/ui/components/primitives";
import { RecipientRow, RowSkeletons, type RecipientItem } from "@/ui/components/rows";
import { Sheet } from "@/ui/components/Sheet";
import shell from "@/ui/components/shell.module.css";
import { destinationFor } from "@/ui/lib/assets";
import { useRecipientData } from "@/ui/lib/data";
import { addPerson, addWallet, editWallet, makePreferred, renamePerson, setArchived } from "@/ui/lib/recipient-actions";
import { getRecipient, isWalletVerified, toneFor, type ApiDestination, type ApiRecipientDetail } from "@/ui/lib/recipients-api";
import { routeIdForPair } from "@/domain/routes";
import { useApiResource } from "@/ui/lib/resource";
import { useSession } from "@/ui/lib/session";
import styles from "./recipients.module.css";

type Filter = "all" | "verified" | "archived";
const FILTERS = [
  { value: "all", label: "All" },
  { value: "verified", label: "Verified" },
  { value: "archived", label: "Archived" },
] as const;

function firstName(name: string): string {
  return name.split(/\s+/)[0] ?? name;
}

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

export function Recipients(): React.JSX.Element {
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const q = useDebounced(query.trim(), 250);
  const people = useRecipientData();
  const list = useRecipientData({ q, archived: filter === "archived" });
  const [addOpen, setAddOpen] = useState(false);
  const [selected, setSelected] = useState<RecipientItem | null>(null);

  const topPeople = people.status === "ready" ? people.items.slice(0, 6) : [];
  const visible =
    list.status === "ready"
      ? list.items.filter((r) => (filter === "archived" ? r.archived : filter === "verified" ? r.walletVerified && !r.archived : !r.archived))
      : [];
  const isPreview = list.status === "ready" && list.preview;

  return (
    <main className={shell.screen}>
      <section className={shell.darkTop}>
        <span className={shell.glow} aria-hidden="true" />
        <div className={shell.titleRow}>
          <h1 className={shell.title}>Recipients</h1>
          <Button variant="light" size="sm" icon="plus" onClick={() => setAddOpen(true)} aria-haspopup="dialog">
            Add
          </Button>
        </div>

        {topPeople.length > 0 ? (
          <ul className={styles.grid} aria-label="People">
            {topPeople.map((r) => (
              <li key={r.id}>
                <button type="button" className={styles.person} onClick={() => setSelected(r)}>
                  <Avatar name={r.name} tone={r.tone} size={64} verified={r.walletVerified} />
                  <span className={styles.personName}>{firstName(r.name)}</span>
                  <span className={styles.personRoute}>{r.routeId ? destinationFor(r.routeId).label : "No wallet yet"}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <div className={styles.placeholderGrid}>
            <button type="button" className={styles.addSlot} onClick={() => setAddOpen(true)}>
              <span className={styles.addCircle}>
                <Icon name="plus" size={24} strokeWidth={2.2} />
              </span>
              <span className={styles.personName}>Add a person</span>
            </button>
            <span className={styles.ghostSlot} aria-hidden="true" />
            <span className={styles.ghostSlot} aria-hidden="true" />
          </div>
        )}
      </section>

      <section className={`${shell.paper} th-light`}>
        <span className={shell.paperHandle} aria-hidden="true" />
        {isPreview && (
          <div className={styles.previewRow}>
            <PreviewTag>Preview people · fictional</PreviewTag>
          </div>
        )}
        <div className={styles.controls}>
          <Segmented label="Filter recipients" options={FILTERS} value={filter} onChange={setFilter} />
          <SearchField label="Search recipients" placeholder="Search by name" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>

        {list.status === "loading" && <RowSkeletons count={4} />}
        {list.status === "error" && (
          <EmptyState
            icon="alert"
            title="Couldn't load your recipients"
            body={list.message}
            action={
              <Button variant="soft" size="md" icon="refresh" onClick={list.retry}>
                Try again
              </Button>
            }
          />
        )}
        {list.status === "disconnected" && (
          <EmptyState icon="users" title="Sign in to see your recipients" body="Your saved people appear here once you're signed in." />
        )}
        {list.status === "ready" && (
          <div className={styles.list} aria-busy={list.refreshing}>
            {visible.map((r) => (
              <RecipientRow
                key={r.id}
                item={r}
                onSelect={() => setSelected(r)}
                trailing={
                  r.routeId && !r.archived ? (
                    <ButtonLink href={`/app/send?to=${r.id}`} variant="soft" size="sm" aria-label={`Pay ${r.name}`}>
                      {(r.transferCount ?? 0) > 0 ? "Pay again" : "Pay"}
                    </ButtonLink>
                  ) : null
                }
              />
            ))}
            {visible.length === 0 && <ListEmpty filter={filter} query={q} onAdd={() => setAddOpen(true)} onReset={() => { setQuery(""); setFilter("all"); }} />}
            {list.hasMore && (
              <div className={styles.more}>
                <Button variant="soft" size="md" onClick={list.loadMore}>
                  Show more
                </Button>
              </div>
            )}
          </div>
        )}
      </section>

      <Sheet open={addOpen} onClose={() => setAddOpen(false)} title="Add a person">
        {addOpen && (isPreview ? <PreviewBlocked /> : <AddPersonForm onDone={() => setAddOpen(false)} />)}
      </Sheet>

      <Sheet open={selected !== null} onClose={() => setSelected(null)} title={selected?.name ?? "Recipient"} hideTitle>
        {selected && (isPreview ? <PreviewDetail item={selected} /> : <RecipientDetailSheet key={selected.id} id={selected.id} />)}
      </Sheet>
    </main>
  );
}

function ListEmpty({ filter, query, onAdd, onReset }: { filter: Filter; query: string; onAdd: () => void; onReset: () => void }): React.JSX.Element {
  if (query) {
    return <EmptyState icon="search" title="No one found" body={`No one matches “${query}”.`} action={<Button variant="soft" size="md" onClick={onReset}>Show everyone</Button>} />;
  }
  if (filter === "verified") {
    return (
      <EmptyState
        icon="shield"
        title="No verified wallets yet"
        body="A wallet shows as verified only after its owner proves they control it."
        action={<Button variant="soft" size="md" onClick={onReset}>Show everyone</Button>}
      />
    );
  }
  if (filter === "archived") {
    return <EmptyState icon="users" title="Nothing archived" body="People you archive are kept here, and you can reopen them anytime." action={<Button variant="soft" size="md" onClick={onReset}>Show everyone</Button>} />;
  }
  return (
    <EmptyState
      icon="users"
      title="Save the people you pay"
      body="Add someone once and Thence remembers their preferred currency and receiving wallet."
      action={
        <Button variant="ink" size="md" icon="plus" onClick={onAdd}>
          Add a person
        </Button>
      }
    />
  );
}

function PreviewBlocked(): React.JSX.Element {
  return (
    <Notice tone="info" icon="eye" title="Preview data is on">
      Saving isn&apos;t available while viewing preview people. Exit preview to manage your real recipients.
    </Notice>
  );
}

function AddPersonForm({ onDone }: { onDone: () => void }): React.JSX.Element {
  const createdId = useRef<string | null>(null);
  return (
    <DestinationForm
      mode="save"
      submitLabel="Save recipient"
      onSubmit={async (draft) => {
        const result = await addPerson(draft, createdId.current);
        createdId.current = result.recipientId;
        if (result.error) return result.error;
        onDone();
        return null;
      }}
    />
  );
}

/* ---------- Detail (real data) ---------- */

type DetailView = { kind: "overview" } | { kind: "rename" } | { kind: "add-wallet" } | { kind: "edit-wallet"; destination: ApiDestination };

function RecipientDetailSheet({ id }: { id: string }): React.JSX.Element {
  const session = useSession();
  const userId = session.status === "valid" ? session.me.user.id : null;
  const resource = useApiResource(userId ? `recipient:${userId}:${id}` : null, (signal) => getRecipient(id, { signal }));
  const [view, setView] = useState<DetailView>({ kind: "overview" });

  if (resource.status === "loading" || resource.status === "idle") {
    return (
      <div className={styles.detail} aria-busy="true">
        <div className={styles.detailHero}>
          <Skeleton width={80} height={80} radius={40} />
          <Skeleton width={160} height={22} />
        </div>
        <Skeleton width="100%" height={120} radius={20} />
      </div>
    );
  }
  if (resource.status === "error") {
    return <EmptyState icon="alert" title="Couldn't open this person" body={resource.message} action={<Button variant="soft" size="md" onClick={resource.retry}>Try again</Button>} />;
  }
  const recipient = resource.data.recipient;
  const back = () => setView({ kind: "overview" });

  if (view.kind === "rename") return <RenameForm recipient={recipient} onDone={back} />;
  if (view.kind === "add-wallet") {
    return (
      <SubView title="Add a receiving wallet" onBack={back}>
        <DestinationForm
          mode="save"
          withName={false}
          offerPreferred={recipient.destinations.length > 0}
          submitLabel="Save wallet"
          onSubmit={async (draft) => {
            const error = await addWallet(recipient.id, { ...draft, makePreferred: recipient.destinations.length === 0 || draft.makePreferred });
            if (!error) back();
            return error;
          }}
        />
      </SubView>
    );
  }
  if (view.kind === "edit-wallet") {
    const routeId = routeIdForPair(view.destination.asset, view.destination.network);
    return (
      <SubView title="Edit receiving wallet" onBack={back}>
        <DestinationForm
          mode="save"
          withName={false}
          initial={{ address: view.destination.address, ...(routeId ? { routeId } : {}) }}
          submitLabel="Save wallet"
          onSubmit={async (draft) => {
            const error = await editWallet(recipient.id, view.destination.id, draft);
            if (!error) back();
            return error;
          }}
        />
      </SubView>
    );
  }
  return <Overview recipient={recipient} onRename={() => setView({ kind: "rename" })} onAddWallet={() => setView({ kind: "add-wallet" })} onEditWallet={(d) => setView({ kind: "edit-wallet", destination: d })} />;
}

function SubView({ title, onBack, children }: { title: string; onBack: () => void; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className={styles.detail}>
      <button type="button" className={styles.backLink} onClick={onBack}>
        <Icon name="chevron-left" size={18} strokeWidth={2.2} />
        Back
      </button>
      <h3 className={styles.subTitle}>{title}</h3>
      {children}
    </div>
  );
}

function RenameForm({ recipient, onDone }: { recipient: ApiRecipientDetail; onDone: () => void }): React.JSX.Element {
  const [name, setName] = useState(recipient.displayName);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!name.trim()) return setError("Add a name so you know who this is.");
    setSaving(true);
    const failure = await renamePerson(recipient.id, name.trim());
    setSaving(false);
    if (failure) setError(failure.message);
    else onDone();
  };
  return (
    <SubView title="Edit name" onBack={onDone}>
      <form className={styles.renameForm} onSubmit={(event) => void submit(event)} noValidate>
        <TextField
          label="Their name"
          value={name}
          onChange={(event) => {
            setName(event.target.value.slice(0, 120));
            setError(null);
          }}
          autoComplete="off"
          autoCapitalize="words"
          error={error}
          autoFocus
        />
        <Button type="submit" variant="ink" block disabled={saving} aria-busy={saving}>
          {saving ? "Saving…" : "Save name"}
        </Button>
      </form>
    </SubView>
  );
}

function Overview({
  recipient,
  onRename,
  onAddWallet,
  onEditWallet,
}: {
  recipient: ApiRecipientDetail;
  onRename: () => void;
  onAddWallet: () => void;
  onEditWallet: (destination: ApiDestination) => void;
}): React.JSX.Element {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const archived = recipient.archivedAt !== null;
  const preferred = recipient.destinations.find((d) => d.isDefault) ?? null;
  const verified = isWalletVerified(preferred?.verification);
  const first = firstName(recipient.displayName);

  const run = async (label: string, action: () => Promise<{ message: string } | null>) => {
    setBusy(label);
    setError(null);
    const failure = await action();
    setBusy(null);
    if (failure) setError(failure.message);
  };

  return (
    <div className={styles.detail}>
      <div className={styles.detailHero}>
        <Avatar name={recipient.displayName} tone={toneFor(recipient.id)} size={80} verified={verified} />
        <p className={styles.detailName}>{recipient.displayName}</p>
        {archived ? (
          <span className={styles.badge}>Archived</span>
        ) : (
          <button type="button" className={styles.textAction} onClick={onRename}>
            Edit name
          </button>
        )}
      </div>

      {archived && (
        <Notice tone="info" icon="info" title="Archived">
          {first} is hidden from your list and can&apos;t be changed or paid. Reopen to use them again.
        </Notice>
      )}

      <div className={styles.walletSection}>
        <p className={styles.walletTitle}>Receiving wallets</p>
        {recipient.destinations.length === 0 && <p className={styles.walletEmpty}>No receiving wallet yet. Add one to pay {first}.</p>}
        {recipient.destinations.map((d) => {
          const routeId = routeIdForPair(d.asset, d.network);
          const dVerified = isWalletVerified(d.verification);
          return (
            <div key={d.id} className={styles.prefCard} data-preferred={d.isDefault}>
              <p className={styles.prefValue}>
                {routeId && <AssetMark asset={destinationFor(routeId).asset} size={28} />}
                <span>
                  <strong>{d.asset}</strong> on {d.network}
                  {d.label && <span className={styles.walletLabel}> · {d.label}</span>}
                </span>
              </p>
              <AddressDisplay address={d.address} />
              <div className={styles.walletBadges}>
                {d.isDefault && <span className={styles.badgeDark}>Preferred</span>}
                <span className={dVerified ? styles.badgeOk : styles.badge}>{dVerified ? "Wallet verified" : "Added by you"}</span>
              </div>
              {!archived && (
                <div className={styles.walletActions}>
                  {!d.isDefault && (
                    <Button variant="soft" size="sm" disabled={busy !== null} onClick={() => void run(`pref-${d.id}`, () => makePreferred(recipient.id, d.id))}>
                      {busy === `pref-${d.id}` ? "Saving…" : "Make preferred"}
                    </Button>
                  )}
                  <Button variant="soft" size="sm" disabled={busy !== null} onClick={() => onEditWallet(d)}>
                    Edit
                  </Button>
                </div>
              )}
            </div>
          );
        })}
        {!archived && (
          <Button variant="soft" block icon="plus" onClick={onAddWallet} disabled={busy !== null}>
            {recipient.destinations.length === 0 ? "Add a receiving wallet" : "Add another wallet"}
          </Button>
        )}
      </div>

      {preferred &&
        (verified ? (
          <Notice tone="info" icon="shield" title="Wallet verified">
            They proved they control their preferred wallet. This doesn&apos;t verify who they are.
          </Notice>
        ) : (
          <Notice tone="warn" icon="info" title="Added by you · not verified">
            Double-check the address with {first} before you pay. Asking someone to verify their wallet isn&apos;t available in Thence yet.
          </Notice>
        ))}

      {error && (
        <Notice tone="error" icon="alert" live>
          {error}
        </Notice>
      )}

      <div className={styles.detailActions}>
        {!archived && preferred && (
          <ButtonLink href={`/app/send?to=${recipient.id}`} variant="ink" block icon="arrow-up-right">
            {recipient.transferCount > 0 ? `Pay ${first} again` : `Pay ${first}`}
          </ButtonLink>
        )}
        {archived ? (
          <Button variant="ink" block icon="refresh" disabled={busy !== null} onClick={() => void run("reopen", () => setArchived(recipient.id, false))}>
            {busy === "reopen" ? "Reopening…" : `Reopen ${first}`}
          </Button>
        ) : (
          <Button variant="ghost" block disabled={busy !== null} onClick={() => void run("archive", () => setArchived(recipient.id, true))}>
            {busy === "archive" ? "Archiving…" : `Archive ${first}`}
          </Button>
        )}
      </div>
    </div>
  );
}

/* ---------- Detail (development preview fixtures only) ---------- */

function PreviewDetail({ item }: { item: RecipientItem }): React.JSX.Element {
  const destination = item.routeId ? destinationFor(item.routeId) : null;
  return (
    <div className={styles.detail}>
      <div className={styles.detailHero}>
        <Avatar name={item.name} tone={item.tone} size={80} verified={item.walletVerified} />
        <p className={styles.detailName}>{item.name}</p>
        <PreviewTag>Preview</PreviewTag>
      </div>
      {destination && (
        <div className={styles.prefCard}>
          <p className={styles.prefLabel}>Receives</p>
          <p className={styles.prefValue}>
            <AssetMark asset={destination.asset} size={28} />
            <span>
              <strong>{destination.asset}</strong> on {destination.network}
            </span>
          </p>
          <p className={styles.prefLabel}>Destination</p>
          {item.address ? <AddressDisplay address={item.address} /> : null}
        </div>
      )}
      {item.walletVerified ? (
        <Notice tone="info" icon="shield" title="Wallet verified">
          They proved they control this address. This doesn&apos;t verify who they are.
        </Notice>
      ) : (
        <Notice tone="warn" icon="info" title="Added by you · not verified">
          Double-check the address with them before you pay.
        </Notice>
      )}
      <div className={styles.detailActions}>
        <ButtonLink href={`/app/send?to=${item.id}`} variant="ink" block icon="arrow-up-right">
          Pay {firstName(item.name)} again
        </ButtonLink>
      </div>
    </div>
  );
}
