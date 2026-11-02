"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ROUTE_IDS, type RouteId } from "@/domain/routes";
import { TRANSFER_STATUSES, isTerminal, type TransferStatus } from "@/domain/transfers";
import { AddressDisplay } from "@/ui/components/AddressDisplay";
import { AmountDisplay, Keypad } from "@/ui/components/AmountEntry";
import { Button, ButtonLink, IconButton } from "@/ui/components/Button";
import { DestinationForm, type DestinationDraft } from "@/ui/components/DestinationForm";
import { DestinationPicker } from "@/ui/components/DestinationPicker";
import { Icon } from "@/ui/components/Icon";
import { AssetMark, NimMark } from "@/ui/components/PaymentCard";
import { Avatar, EmptyState, Notice, PreviewTag, SearchField, Segmented, Skeleton } from "@/ui/components/primitives";
import { RecipientRow, RowSkeletons, type RecipientItem } from "@/ui/components/rows";
import { Sheet } from "@/ui/components/Sheet";
import shell from "@/ui/components/shell.module.css";
import { SwipeToConfirm } from "@/ui/components/SwipeToConfirm";
import { Timeline } from "@/ui/components/Timeline";
import type { AvatarTone } from "@/ui/fixtures/preview";
import { ASSET_META, DEFAULT_DESTINATION, destinationFor, isEvmNetwork, maskAddress } from "@/ui/lib/assets";
import { amountIssue, evaluate, formatFixed, keyFromKeyboard, type CalcKey } from "@/ui/lib/calculator";
import { cn } from "@/ui/lib/cn";
import { useRecipientData } from "@/ui/lib/data";
import { addPerson } from "@/ui/lib/recipient-actions";
import { canSaveNetwork, toneFor } from "@/ui/lib/recipients-api";
import { checkSendAmount, quoteRows, quoteWarnings, type AmountBlock, type QuoteInput } from "@/ui/lib/quotes-api";
import { canPayRequest, getPublicRequest, isPublicId, requestRouteId, type ApiOwnerRequest, type ApiPublicRequest } from "@/ui/lib/requests-api";
import { useApiResource } from "@/ui/lib/resource";
import { availabilityFor, tokenDecimalsFor, useRouteCatalogue } from "@/ui/lib/routes-api";
import { useSession } from "@/ui/lib/session";
import { timelineFor } from "@/ui/lib/status";
import { usePreviewMode } from "@/ui/lib/stores";
import { isPaymentFlagEnabled } from "@/ui/lib/payment-gate";
import { RequestDetailsStep, RequestSharedStep } from "./RequestSteps";
import { useCalculator } from "./useCalculator";
import { humanAmount } from "@/ui/lib/transfers-api";
import { useLiveQuote } from "./useLiveQuote";
import { useHandoff } from "./useHandoff";
import { SettlementProgress } from "./SettlementProgress";
import { usePreparation, type PreparationInput } from "./usePreparation";
import { WalletChooser, type ChosenWallet } from "./WalletChooser";
import { clearPending, displayAmountForHandoff, fetchTransfer, isPendingTransferResumable } from "@/ui/lib/prepare-flow";
import { evmChainIdFor, tokenAddressFor } from "@/ui/lib/routes-api";
import { resolveSendNavigation } from "@/ui/lib/send-navigation";
import type { ApiQuote } from "@/ui/lib/quotes-api";
import styles from "./send.module.css";

type Step = "who" | "amount" | "review" | "handoff" | "request-details" | "request-shared";
type Mode = "send" | "request";

interface Payee {
  id: string | null;
  name: string;
  tone: AvatarTone;
  routeId: RouteId;
  address: string;
  walletVerified: boolean;
  isNew: boolean;
  /** Saved wallet being paid (null for a one-off address or a request). */
  destinationId: string | null;
  walletCount: number;
}

/** A payment request being paid: its terms are fixed by the server snapshot. */
interface FixedTerms {
  publicId: string;
  amount: string;
  amountAtomic: string;
  memo: string | null;
}

const MODE_OPTIONS = [
  { value: "send", label: "Send" },
  { value: "request", label: "Request" },
] as const;

type PayableRecipient = RecipientItem & { routeId: RouteId; address: string };

/** Only active people with a preferred receiving wallet can be paid. */
function isPayable(item: RecipientItem): item is PayableRecipient {
  return item.routeId !== null && item.address !== null && !item.archived;
}

function payeeFrom(item: PayableRecipient): Payee {
  return {
    id: item.id,
    name: item.name,
    tone: item.tone,
    routeId: item.routeId,
    address: item.address,
    walletVerified: item.walletVerified,
    isNew: false,
    destinationId: null,
    walletCount: item.destinationCount ?? 1,
  };
}

function payeeFromRequest(request: ApiPublicRequest, routeId: RouteId): Payee {
  return { id: null, name: request.recipientName, tone: "sand", routeId, address: request.destination, walletVerified: false, isNew: true, destinationId: null, walletCount: 1 };
}

function firstName(name: string): string {
  return name.split(/\s+/)[0] ?? name;
}

/** One-off recipients may be unnamed: show a neutral label instead of an empty name. */
function labelFor(payee: Payee): string {
  return payee.name || "New recipient";
}

/** Requests can't use Lightning wallets yet (the backend rejects them). */
const requestableRoute = (id: RouteId) => isEvmNetwork(destinationFor(id).network);

function displayDecimalsFor(amount: string, entryDecimals: number): number {
  return Math.max(entryDecimals, (amount.split(".")[1] ?? "").length);
}

export function SendFlow(): React.JSX.Element {
  const params = useSearchParams();
  const router = useRouter();
  const session = useSession();
  const preview = usePreviewMode();
  const recipientData = useRecipientData();
  const catalogueState = useRouteCatalogue();
  const catalogue = catalogueState.status === "ready" ? catalogueState.catalogue : null;
  const recipients =
    recipientData.status === "ready" ? { ...recipientData, items: recipientData.items.filter(isPayable) } : recipientData;
  const initialMode: Mode = params.get("mode") === "request" ? "request" : "send";
  const navigation = resolveSendNavigation(params.toString(), initialMode);
  const explicitNewIntent = navigation.kind === "new" && navigation.explicit;
  const prefillId = params.get("to");
  const requestParam = params.get("request");
  const requestId = isPublicId(requestParam) ? requestParam : null;

  const [mode, setMode] = useState<Mode>(initialMode);
  const [step, setStep] = useState<Step>(initialMode === "request" ? "amount" : "who");
  const [payee, setPayee] = useState<Payee | null>(null);
  const [fixed, setFixed] = useState<FixedTerms | null>(null);
  const [requestRoute, setRequestRoute] = useState<RouteId>(DEFAULT_DESTINATION);
  const newFormRef = useRef<HTMLDivElement>(null);
  const savedRef = useRef<HTMLDivElement>(null);
  const [routeSheetOpen, setRouteSheetOpen] = useState(false);
  const [walletSheet, setWalletSheet] = useState<{ recipientId: string; name: string; thenAmount: boolean } | null>(null);
  const [query, setQuery] = useState("");
  const [calc, dispatch] = useCalculator();
  const [appliedPrefill, setAppliedPrefill] = useState<string | null>(null);
  const [appliedRequest, setAppliedRequest] = useState<string | null>(null);
  const [triedEmpty, setTriedEmpty] = useState(false);
  const [created, setCreated] = useState<ApiOwnerRequest | null>(null);
  const preparation = usePreparation();
  const handoff = useHandoff();
  const [handoffInput, setHandoffInput] = useState<PreparationInput | null>(null);
  const ownerUserId = session.status === "valid" ? session.me.user.id : null;
  // Re-read after clearing a stale pointer so the banner disappears immediately.
  const [pendingEpoch, setPendingEpoch] = useState(0);
  // pendingEpoch forces a re-read after a stale pointer is cleared; the
  // callback intentionally ignores it.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const pending = useMemo(() => preparation.pendingFor(ownerUserId), [preparation, ownerUserId, pendingEpoch]);
  // A new-payment navigation invalidates any old same-mount resume completion.
  // This matters on mobile where the Send tab can change only the query string,
  // leaving the page component mounted.
  const navigationGeneration = useRef(0);
  const newIntentSeen = useRef(false);

  // Paying a request link: public terms only, read straight from the server snapshot.
  const requestResource = useApiResource(requestId ? `pay-request:${requestId}` : null, (signal) => getPublicRequest(requestId as string, { signal }));
  const openedRequest = requestResource.status === "ready" ? requestResource.data.request : null;
  if (requestId && appliedRequest !== requestId && openedRequest) {
    setAppliedRequest(requestId);
    const routeId = requestRouteId(openedRequest);
    if (routeId && canPayRequest(openedRequest)) {
      setPayee(payeeFromRequest(openedRequest, routeId));
      setFixed({ publicId: openedRequest.publicId, amount: openedRequest.amount, amountAtomic: openedRequest.amountAtomic, memo: openedRequest.memo });
      setMode("send");
      setStep("review");
    }
  }
  const unpayableRequest = openedRequest && !canPayRequest(openedRequest) ? openedRequest : null;

  // Pay Again: adopt the prefilled recipient once data is available.
  if (prefillId && appliedPrefill !== prefillId && recipients.status === "ready") {
    const match = recipients.items.find((r) => r.id === prefillId);
    setAppliedPrefill(prefillId);
    if (match) {
      setPayee(payeeFrom(match));
      setMode("send");
      setStep("amount");
    }
  }

  const routeId = mode === "send" ? (payee?.routeId ?? DEFAULT_DESTINATION) : requestRoute;
  const destination = destinationFor(routeId);
  const decimals = ASSET_META[destination.asset].entryDecimals;
  const evaluation = useMemo(() => evaluate(calc.tokens, decimals), [calc.tokens, decimals]);
  const issue = amountIssue(evaluation);
  const finalAmount = evaluation.kind === "value" ? evaluation.value : "0";
  const availability = catalogueState.status === "loading" ? "loading" : catalogueState.status === "error" ? "unknown" : availabilityFor(routeId, catalogue).availability;
  const amountCheck = checkSendAmount({
    value: evaluation.kind === "value" ? evaluation.value : null,
    issue,
    availability,
    tokenDecimals: tokenDecimalsFor(routeId, catalogue),
  });
  const amountOk = mode === "request" ? issue === null && availability === "available" : amountCheck.ok && payee !== null;

  const onKey = useCallback(
    (key: CalcKey) => {
      setTriedEmpty(false);
      dispatch({ type: "key", key, decimals });
    },
    [dispatch, decimals],
  );

  const choosePayee = (next: Payee) => {
    setPayee(next);
    setFixed(null);
    dispatch({ type: "reset" });
    setMode("send");
    if (next.id && next.walletCount > 1 && !preview) {
      setWalletSheet({ recipientId: next.id, name: firstName(next.name), thenAmount: true });
      return;
    }
    setStep("amount");
  };

  // Retry pointer for a "Save this recipient" whose wallet step failed.
  // Scoped to the exact address+route so an edited form starts fresh.
  const lastDraftRef = useRef<{ address: string; routeId: RouteId; recipientId: string } | null>(null);
  const submitNewAddress = async (draft: DestinationDraft) => {
    const retryId =
      lastDraftRef.current !== null &&
      lastDraftRef.current.address === draft.address &&
      lastDraftRef.current.routeId === draft.routeId
        ? lastDraftRef.current.recipientId
        : null;
    if (draft.save) {
      const { recipientId, error } = await addPerson(draft, retryId);
      if (error || !recipientId) {
        if (recipientId) lastDraftRef.current = { address: draft.address, routeId: draft.routeId, recipientId };
        return error ?? { field: "form", message: "Couldn't save this recipient. Untick “Save this recipient” to pay without saving." };
      }
      lastDraftRef.current = null;
      choosePayee({ id: recipientId, name: draft.name, tone: toneFor(recipientId), routeId: draft.routeId, address: draft.address, walletVerified: false, isNew: false, destinationId: null, walletCount: 1 });
      return null;
    }
    choosePayee({ id: null, name: draft.name, tone: "sand", routeId: draft.routeId, address: draft.address, walletVerified: false, isNew: true, destinationId: null, walletCount: 1 });
    return null;
  };

  const chooseWallet = (wallet: ChosenWallet) => {
    const thenAmount = walletSheet?.thenAmount ?? false;
    setPayee((p) => (p ? { ...p, routeId: wallet.routeId, address: wallet.address, walletVerified: wallet.verified, destinationId: wallet.destinationId } : p));
    setWalletSheet(null);
    if (thenAmount) setStep("amount");
  };

  const toNext = useCallback(() => {
    if (!amountOk) {
      if (issue === "empty") setTriedEmpty(true);
      return;
    }
    dispatch({ type: "commit", decimals });
    setStep(mode === "send" ? "review" : "request-details");
  }, [amountOk, issue, mode, dispatch, decimals]);

  useEffect(() => {
    if (step !== "amount") return;
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, [contenteditable], dialog")) return;
      if (event.key === "Enter") {
        if (target?.closest("button")) return;
        toNext();
        return;
      }
      const key = keyFromKeyboard(event.key);
      if (!key || event.metaKey || event.ctrlKey || event.altKey) return;
      event.preventDefault();
      onKey(key);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [step, onKey, toNext]);

  const caption = (() => {
    const who = mode === "request" ? "What you'll receive" : payee?.name ? `What ${firstName(payee.name)} receives` : "What they receive";
    switch (calc.rejection) {
      case "precision":
        return { text: `${destination.asset} amounts use up to ${decimals} decimal places.`, tone: "error" as const };
      case "too-large":
        return { text: "Amounts are limited to 9 digits.", tone: "error" as const };
      case "leading-operator":
        return { text: "Start with a number.", tone: "error" as const };
      case "too-long":
        return { text: "That calculation is too long.", tone: "error" as const };
      default:
        break;
    }
    if (issue === "divide-by-zero") return { text: "You can't divide by zero.", tone: "error" as const };
    if (issue === "negative") return { text: "The amount must be more than zero.", tone: "error" as const };
    if (issue === "zero") return { text: "Enter an amount above zero.", tone: "error" as const };
    if (issue === "too-large") return { text: "Amounts are limited to 9 digits.", tone: "error" as const };
    if (issue === "empty" && triedEmpty) return { text: mode === "request" ? "Enter how much you'd like to receive." : "Enter how much they should receive.", tone: "error" as const };
    const block: AmountBlock | null = mode === "request" ? (availability === "available" ? null : availability === "loading" ? "checking" : availability === "unknown" ? "unknown" : "unavailable") : amountCheck.ok ? null : amountCheck.block;
    if (issue === null && block === "unavailable") return { text: `${destination.sentence} isn't available right now. Choose another currency.`, tone: "error" as const };
    if (issue === null && block === "unknown") return { text: "We couldn't check availability. Try again in a moment.", tone: "error" as const };
    if (issue === null && block === "precision") return { text: `That amount can't be sent exactly in ${destination.asset}.`, tone: "error" as const };
    if (evaluation.kind === "value" && !evaluation.exact) {
      return { text: `Rounded down to ${formatFixed(evaluation.value, decimals)}. ${destination.asset} uses ${decimals} decimal places.`, tone: "note" as const };
    }
    return { text: who, tone: "muted" as const };
  })();

  const canSaveRecipients = session.status === "valid" && !preview;
  // Receipt save offer: one-off sends only (saved payees and fixed requests
  // already have a home). Shown on the successful receipt when appropriate.
  const receiptSaveOffer =
    payee !== null &&
    payee.id === null &&
    payee.isNew &&
    fixed === null &&
    session.status === "valid" &&
    !preview &&
    canSaveNetwork(payee.routeId)
      ? { address: payee.address, routeId: payee.routeId }
      : null;
  const scrollToNewForm = () => {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    newFormRef.current?.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
  };

  const filtered =
    recipients.status === "ready"
      ? recipients.items.filter((r) => r.name.toLowerCase().includes(query.trim().toLowerCase()))
      : [];
  const sheetUp = step !== "who";
  const resetToWho = () => {
    dispatch({ type: "reset" });
    setPayee(null);
    setFixed(null);
    setStep("who");
  };

  // Review inputs. Fixed (request) terms win; otherwise the exact entered amount.
  const reviewAmount = fixed ? fixed.amount : finalAmount;
  const reviewDecimals = displayDecimalsFor(reviewAmount, decimals);
  const quoteInput: QuoteInput | null =
    preview || !payee || session.status !== "valid"
      ? null
      : fixed
        ? availabilityFor(payee.routeId, catalogue).availability === "available"
          ? { routeId: payee.routeId, targetAmountAtomic: fixed.amountAtomic, requestId: fixed.publicId }
          : null
        : amountCheck.ok
          ? { routeId: payee.routeId, targetAmountAtomic: amountCheck.atomic }
          : null;
  const unavailableReason = preview
    ? "preview"
    : catalogueState.status === "loading"
      ? "checking"
      : payee && availabilityFor(payee.routeId, catalogue).availability !== "available"
        ? "unavailable"
        : null;

  const targetAmountAtomicForHandoff =
    fixed != null ? fixed.amountAtomic : amountCheck.ok ? amountCheck.atomic : null;
  const reviewAmountForHandoff = reviewAmount;
  // Handoff hero amount, derived from the transfer's own atomic terms so a
  // reload-and-resume (empty calculator) never shows a fabricated "0".
  const handoffDisplayAmount = handoffInput
    ? displayAmountForHandoff({
        fixedAmount: handoffInput.fixed ? (fixed?.amount ?? handoffInput.targetAmountAtomic) : null,
        targetAmountAtomic: handoffInput.targetAmountAtomic,
        asset: destinationFor(handoffInput.payee.routeId).asset,
        fallback: reviewAmountForHandoff,
      })
    : reviewAmountForHandoff;

  const buildHandoffInput = (): PreparationInput | null => {
    if (!payee || !targetAmountAtomicForHandoff || !ownerUserId) return null;
    const tokenAddress = tokenAddressFor(payee.routeId, catalogue);
    const evmChainId = evmChainIdFor(payee.routeId, catalogue);
    if (!tokenAddress || !evmChainId) return null;
    return {
      payee: {
        id: payee.id,
        destinationId: payee.destinationId,
        routeId: payee.routeId,
        address: payee.address,
        name: payee.name || null,
      },
      fixed: fixed ? { publicId: fixed.publicId, amountAtomic: fixed.amountAtomic } : null,
      targetAmountAtomic: targetAmountAtomicForHandoff,
      destination: payee.address,
      ownerUserId,
      quoteRevisionHint: null,
      tokenAddress,
      evmChainId,
    };
  };

  const resetForNewIntent = useCallback((): void => {
    navigationGeneration.current += 1;
    preparation.reset();
    handoff.reset();
    dispatch({ type: "reset" });
    setMode("send");
    setStep("who");
    setPayee(null);
    setFixed(null);
    setHandoffInput(null);
    setCreated(null);
    setQuery("");
    setTriedEmpty(false);
    setAppliedPrefill(null);
    setAppliedRequest(null);
  }, [dispatch, handoff, preparation]);

  useEffect(() => {
    if (!explicitNewIntent) {
      newIntentSeen.current = false;
      return;
    }
    if (newIntentSeen.current) return;
    newIntentSeen.current = true;
    resetForNewIntent();
    // Strip the one-shot marker. The reset above is the source of truth; the
    // clean URL prevents a later refresh from looking like a resume action.
    router.replace("/app/send", { scroll: false });
  }, [explicitNewIntent, resetForNewIntent, router]);

  const continuePendingPayment = async (transferId: string): Promise<void> => {
    if (!ownerUserId) return;
    const generation = navigationGeneration.current;
    // Explicit resume (deep link or banner tap) abandons any same-mount run
    // stuck short of its own timeout: reset frees its lock and retires its
    // generation so late completions stay inert. Same transfer, idempotent
    // server paths — never a new payment. Fresh mounts: harmless no-op.
    preparation.reset();
    const current = await fetchTransfer(transferId);
    if (generation !== navigationGeneration.current || !current.ok) return;
    const t = current.data.transfer;
    if (!isPendingTransferResumable(t.status)) {
      // Terminal pointers are stale: clear so the banner goes away. Unknown
      // states keep the pointer (never discard unresolved recovery material).
      if ((TRANSFER_STATUSES as readonly string[]).includes(t.status) && isTerminal(t.status as TransferStatus)) {
        clearPending(ownerUserId, transferId);
        setPendingEpoch((n) => n + 1);
      }
      return;
    }
    const routeId = (ROUTE_IDS as readonly string[]).includes(t.routeId) ? (t.routeId as RouteId) : null;
    if (!routeId) return;
    if (generation !== navigationGeneration.current) return;
    const tokenAddress = tokenAddressFor(routeId, catalogue);
    const evmChainId = evmChainIdFor(routeId, catalogue);
    if (!tokenAddress || !evmChainId) return;
    const input: PreparationInput = {
      payee: {
        id: null,
        destinationId: t.recipientDestinationId ?? null,
        routeId,
        address: t.destination,
        name: t.recipientName ?? t.destination,
      },
      fixed: t.requestPublicId ? { publicId: t.requestPublicId, amountAtomic: t.targetAmountAtomic } : null,
      targetAmountAtomic: t.targetAmountAtomic,
      destination: t.destination,
      ownerUserId,
      quoteRevisionHint: t.quote?.revision ?? null,
      tokenAddress,
      evmChainId,
    };
    setHandoffInput(input);
    // Rebuild a minimal payee so Back still shows context.
    setPayee({
      id: null,
      name: t.recipientName?.trim() || "They",
      tone: "sand",
      routeId,
      address: t.destination,
      walletVerified: false,
      isNew: true,
      destinationId: t.recipientDestinationId ?? null,
      walletCount: 1,
    });
    // Seed the calculator from the authoritative saved terms so review and
    // quoting derive from the real 0.30 (or whatever was saved) instead of
    // the empty local form — a zero-valued form is never the payment.
    // Unrepresentable terms keep the current input (never fabricate).
    const authored = humanAmount(t.targetAmountAtomic, destinationFor(routeId).asset);
    if (authored !== null) dispatch({ type: "seed", value: authored });
    if (generation !== navigationGeneration.current) return;
    setStep("handoff");
    await preparation.resumeWithInput(input, transferId);
  };

  // Deep link from Activity ("Resume payment"): continue the SAME transfer.
  // Server-validated (unknown/foreign ids are a silent no-op); never creates.
  // A mobile New payment navigation explicitly wins over any stale query.
  const resumeParam = navigation.kind === "resume" ? navigation.transferId : null;
  const resumedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!resumeParam || session.status !== "valid" || !ownerUserId || !catalogue) return;
    if (resumedRef.current === resumeParam) return;
    resumedRef.current = resumeParam;
    router.replace("/app/send", { scroll: false });
    void continuePendingPayment(resumeParam);
    // Intentionally runs once per link; resume is idempotent server-side.
    // Waits for the route catalogue so token/chain mapping cannot silently
    // no-op on a cold load; the guard above retries via these deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resumeParam, session.status, ownerUserId, catalogue]);

  return (
    <div className={styles.flow} data-sheet={sheetUp}>
      {/* Step 1 — Who are you paying? */}
      <main className={cn(shell.screen, styles.who)} aria-hidden={sheetUp} inert={sheetUp}>
        <section className={shell.darkTop}>
          <span className={shell.glow} aria-hidden="true" />
          <h1 className={shell.title}>Send money</h1>
          <p className={styles.lede}>Pay a wallet address directly, or pick someone you&apos;ve saved.</p>

          {requestId && requestResource.status === "loading" && (
            <p className={styles.requestOpening} role="status">
              Opening the payment request…
            </p>
          )}
          {requestId && requestResource.status === "error" && (
            <div className={styles.requestNotice}>
              <Notice tone="dark" icon="alert" title="Couldn't open that request">
                {requestResource.message}
              </Notice>
            </div>
          )}
          {unpayableRequest && (
            <div className={styles.requestNotice}>
              <Notice tone="dark" icon="alert" title="This request can't be paid">
                {unpayableRequest.status === "active"
                  ? `${unpayableRequest.asset} on ${unpayableRequest.network} isn't available right now.`
                  : `It was ${unpayableRequest.status === "expired" ? "set to expire and has now expired" : "cancelled"}. Ask ${firstName(unpayableRequest.recipientName)} for a new link.`}
              </Notice>
            </div>
          )}
          {pending && step === "who" && session.status === "valid" && (
            <div className={styles.requestNotice}>
              <Notice tone="dark" icon="clock" title="Continue an interrupted payment">
                You started a payment that hasn&apos;t finished preparing. Its outcome is not confirmed; check Activity before continuing.
              </Notice>
              <div style={{ marginTop: 8 }}>
                <Button
                  variant="soft"
                  size="md"
                  icon="arrow-right"
                  block
                  onClick={() => void continuePendingPayment(pending.transferId)}
                >
                  Continue payment
                </Button>
              </div>
            </div>
          )}

          <div ref={newFormRef}>
            <DestinationForm submitLabel="Continue" nameOptional addressFirst offerSave={canSaveRecipients} stickyCta onSubmit={submitNewAddress} />
          </div>

          {recipients.status === "ready" && recipients.items.length > 0 && (
            <>
              <p className={styles.facesLabel}>Recent</p>
              <ul className={styles.faces} aria-label="Recent people">
                {recipients.items.slice(0, 3).map((r) => (
                  <li key={r.id}>
                    <button type="button" className={styles.face} onClick={() => choosePayee(payeeFrom(r))}>
                      <Avatar name={r.name} tone={r.tone} size={56} verified={r.walletVerified} />
                      <span className={styles.faceName}>{firstName(r.name)}</span>
                      <span className={styles.faceRoute}>{destinationFor(r.routeId).label}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>

        <section className={`${shell.paper} th-light`}>
          <span className={shell.paperHandle} aria-hidden="true" />
          <div className={shell.sectionHead} ref={savedRef}>
            <h2 className={shell.sectionTitle} id="saved-recipients" tabIndex={-1}>
              Saved recipients {recipients.status === "ready" && recipients.preview && <PreviewTag />}
            </h2>
          </div>
          {recipients.status === "loading" && <RowSkeletons count={3} />}
          {recipients.status === "error" && (
            <EmptyState
              icon="alert"
              title="Couldn't load your people"
              body={recipients.message}
              action={
                <Button variant="soft" size="md" icon="refresh" onClick={recipients.retry}>
                  Try again
                </Button>
              }
            />
          )}
          {recipients.status === "disconnected" && (
            <EmptyState
              icon="users"
              title="Your people will appear here"
              body="Once your wallet is connected, everyone you save shows up here with what they receive."
              action={
                <Button variant="ink" size="md" icon="plus" onClick={scrollToNewForm}>
                  Pay someone new
                </Button>
              }
            />
          )}
          {recipients.status === "ready" && (
            <>
              <SearchField label="Search saved people" placeholder="Search by name" value={query} onChange={(e) => setQuery(e.target.value)} />
              <div className={styles.list}>
                {filtered.map((r) => (
                  <RecipientRow key={r.id} item={r} onSelect={() => choosePayee(payeeFrom(r))} />
                ))}
                {filtered.length === 0 &&
                  (query.trim() ? (
                    <EmptyState icon="search" title="No one found" body={`No saved person matches “${query.trim()}”.`} />
                  ) : (
                    <EmptyState
                      icon="users"
                      title="No saved people yet"
                      body="People you save with a receiving wallet appear here."
                      action={
                        <ButtonLink href="/app/recipients" variant="soft" size="md" icon="plus">
                          Add a person
                        </ButtonLink>
                      }
                    />
                  ))}
              </div>
            </>
          )}
        </section>
      </main>

      {/* Steps 2–4 — the white sheet */}
      {sheetUp && (
        <section
          className={`${styles.sheet} th-light`}
          aria-label={step === "amount" ? "Amount" : step === "review" ? "Review payment" : step === "handoff" ? "Approval" : "Request money"}
        >
          {step === "amount" && (
            <div className={styles.amountStep} key="amount">
              <header className={styles.sheetTop}>
                <IconButton
                  icon="chevron-down"
                  label={mode === "request" ? "Close" : "Back to choosing who you're paying"}
                  tone="light"
                  onClick={() => setStep("who")}
                />
                <Segmented
                  label="Send or request"
                  options={MODE_OPTIONS}
                  value={mode}
                  onChange={(next) => {
                    setMode(next);
                    setTriedEmpty(false);
                    dispatch({ type: "reset" });
                  }}
                />
                {mode === "request" && !preview ? (
                  <IconButton icon="receipt" label="Your requests" tone="light" onClick={() => router.push("/app/requests")} />
                ) : (
                  <span className={styles.topSpacer} aria-hidden="true" />
                )}
              </header>

              {mode === "send" ? (
                <div className={styles.payeeStack}>
                  <button type="button" className={styles.payeeLine} onClick={() => setStep("who")}>
                    {payee ? (
                      <>
                        <Avatar name={labelFor(payee)} tone={payee.tone} size={26} />
                        <span>
                          <strong>{payee.name ? firstName(payee.name) : labelFor(payee)}</strong> · {destination.sentence}
                        </span>
                      </>
                    ) : (
                      <span>
                        <strong>Choose who you&apos;re paying</strong>
                      </span>
                    )}
                    <Icon name="chevron-down" size={16} strokeWidth={2.4} />
                  </button>
                  {payee &&
                    (payee.id && payee.walletCount > 1 && !preview ? (
                      <button
                        type="button"
                        className={styles.walletLine}
                        onClick={() => setWalletSheet({ recipientId: payee.id as string, name: firstName(payee.name), thenAmount: false })}
                        aria-haspopup="dialog"
                      >
                        <Icon name="wallet" size={14} />
                        <span className={styles.mono}>{maskAddress(payee.address)}</span>
                        <span className={styles.walletChange}>Change wallet</span>
                      </button>
                    ) : (
                      <span className={styles.walletLine} data-static="true">
                        <Icon name="wallet" size={14} />
                        <span className={styles.mono}>{maskAddress(payee.address)}</span>
                      </span>
                    ))}
                </div>
              ) : (
                <button type="button" className={styles.payeeLine} onClick={() => setRouteSheetOpen(true)} aria-haspopup="dialog">
                  <AssetMark asset={destination.asset} size={22} />
                  <span>
                    <strong>You receive</strong> · {destination.sentence}
                  </span>
                  <Icon name="chevron-down" size={16} strokeWidth={2.4} />
                </button>
              )}

              <div className={styles.displayArea}>
                <AmountDisplay
                  tokens={calc.tokens}
                  asset={destination.asset}
                  decimals={decimals}
                  evaluation={evaluation}
                  inputNonce={calc.inputNonce}
                  animateLast={calc.animateLast}
                  shakeNonce={calc.shakeNonce}
                  onCommit={() => dispatch({ type: "commit", decimals })}
                  caption={caption.text}
                  captionTone={caption.tone}
                />
              </div>

              <Keypad onKey={onKey} />

              <div className={styles.cta}>
                {mode === "send" ? (
                  <Button variant="ink" block onClick={toNext} disabled={!amountOk} trailingIcon="arrow-right">
                    Review
                  </Button>
                ) : preview ? (
                  <>
                    <Button variant="ink" block disabled aria-describedby="request-blocked">
                      Continue
                    </Button>
                    <p id="request-blocked" className={styles.ctaNote}>
                      <Icon name="lock" size={14} />
                      Requests need a connected wallet, not preview.
                    </p>
                  </>
                ) : (
                  <Button variant="ink" block onClick={toNext} disabled={!amountOk} trailingIcon="arrow-right">
                    Continue
                  </Button>
                )}
              </div>
            </div>
          )}

          {step === "review" && payee && (
            <ReviewStep
              payee={payee}
              amount={reviewAmount}
              decimals={reviewDecimals}
              tokenDecimals={tokenDecimalsFor(payee.routeId, catalogue) ?? ASSET_META[destinationFor(payee.routeId).asset].chainDecimals}
              fixed={fixed}
              quoteInput={quoteInput}
              unavailableReason={unavailableReason}
              onBack={() => (fixed ? router.push(`/r/${fixed.publicId}`) : setStep("amount"))}
              onApprove={() => {
                const input = buildHandoffInput();
                if (!input) return;
                setHandoffInput(input);
                setStep("handoff");
                void preparation.start(input);
              }}
            />
          )}

          {step === "handoff" && handoffInput && (
            <HandoffStep
              payeeName={handoffInput.payee.name || payee?.name || "They"}
              amount={handoffDisplayAmount}
              assetLabel={destinationFor(handoffInput.payee.routeId).asset}
              routeId={handoffInput.payee.routeId}
              asset={destinationFor(handoffInput.payee.routeId).asset}
              requestPublicId={handoffInput.fixed?.publicId ?? null}
              saveOffer={receiptSaveOffer}
              preparation={preparation.state}
              handoff={handoff}
              ownerUserId={ownerUserId}
              sessionValid={session.status === "valid"}
              previewMode={preview}
              onRetry={() => void preparation.retry()}
              onBack={() => setStep("review")}
              onRequote={() => void preparation.requoteAndRetry()}
              onAcceptReprice={(accepted) => void preparation.acceptReprice(accepted)}
              onDone={() => {
                preparation.reset();
                handoff.reset();
                setHandoffInput(null);
                resetToWho();
              }}
            />
          )}

          {step === "request-details" && (
            <RequestDetailsStep
              routeId={requestRoute}
              amount={finalAmount}
              decimals={decimals}
              defaultName={session.status === "valid" ? (session.me.profile.displayName ?? "") : ""}
              onBack={() => setStep("amount")}
              onCreated={(request) => {
                setCreated(request);
                setStep("request-shared");
              }}
            />
          )}

          {step === "request-shared" && created && (
            <RequestSharedStep
              request={created}
              onDone={() => {
                setCreated(null);
                dispatch({ type: "reset" });
                setStep("amount");
              }}
            />
          )}
        </section>
      )}


      <Sheet open={routeSheetOpen} onClose={() => setRouteSheetOpen(false)} title="You receive">
        <DestinationPicker
          label="What should the payer send you?"
          value={requestRoute}
          allow={requestableRoute}
          onChange={(next) => {
            setRequestRoute(next);
            dispatch({ type: "reset" });
            setRouteSheetOpen(false);
          }}
        />
      </Sheet>

      <Sheet
        open={walletSheet !== null}
        onClose={() => {
          if (walletSheet?.thenAmount) setStep("amount");
          setWalletSheet(null);
        }}
        title="Receiving wallet"
      >
        {walletSheet && <WalletChooser recipientId={walletSheet.recipientId} name={walletSheet.name} selectedId={payee?.destinationId ?? null} onChoose={chooseWallet} />}
      </Sheet>
    </div>
  );
}

interface ReviewProps {
  payee: Payee;
  amount: string;
  decimals: number;
  tokenDecimals: number;
  fixed: FixedTerms | null;
  quoteInput: QuoteInput | null;
  unavailableReason: "preview" | "checking" | "unavailable" | null;
  onBack: () => void;
  onApprove: () => void;
}

function ReviewStep({ payee, amount, decimals, tokenDecimals, fixed, quoteInput, unavailableReason, onBack, onApprove }: ReviewProps): React.JSX.Element {
  const destination = destinationFor(payee.routeId);
  const formatted = formatFixed(amount, decimals);
  const quote = useLiveQuote(quoteInput, payee.address);
  const fresh = quote.status === "ready";
  const rows = fresh ? quoteRows(quote.quote, decimals, tokenDecimals) : null;
  const lightningRow = rows?.find((r) => r.label === "Lightning needed");

  return (
    <div className={styles.reviewStep} key="review">
      <header className={styles.sheetTop}>
        <IconButton icon="arrow-left" label={fixed ? "Back to the request" : "Back to amount"} tone="light" onClick={onBack} />
        <h2 className={styles.sheetTitle}>Review payment</h2>
        <span className={styles.topSpacer} aria-hidden="true" />
      </header>

      <div className={styles.reviewScroll}>
        <div className={styles.reviewHero}>
          <Avatar name={labelFor(payee)} tone={payee.tone} size={64} verified={payee.walletVerified} />
          <p className={styles.reviewWho}>{payee.name ? `${firstName(payee.name)} receives` : "They receive"}</p>
          <p className={styles.reviewAmount}>
            <span className="tabular">{formatted}</span> <span className={styles.reviewAsset}>{destination.asset}</span>
          </p>
          <p className={styles.reviewNet}>
            <AssetMark asset={destination.asset} size={18} /> on {destination.network}
          </p>
          {fixed && (
            <p className={styles.fixedTag}>
              <Icon name="lock" size={13} /> Amount set by {firstName(payee.name)}&apos;s request
            </p>
          )}
        </div>

        <QuoteStatus quote={quote} unavailableReason={unavailableReason} onBack={onBack} fixed={fixed !== null} />

        <dl className={styles.details}>
          <div>
            <dt>Recipient</dt>
            <dd>
              <span>{labelFor(payee)}</span>
              <span className={payee.walletVerified ? styles.badgeOk : styles.badge}>
                {payee.walletVerified ? "Wallet verified" : fixed ? "From their request" : payee.isNew ? "New destination" : "Added by you"}
              </span>
            </dd>
          </div>
          <div>
            <dt>Receiving wallet</dt>
            <dd>
              <AddressDisplay address={payee.address} align="end" />
            </dd>
          </div>
          <div>
            <dt>Network</dt>
            <dd>{destination.network}</dd>
          </div>
          <div>
            <dt>They receive</dt>
            <dd>
              <span className="tabular">
                {formatted} {destination.asset}
              </span>
              <span className={styles.ddSub}>Exact amount</span>
            </dd>
          </div>
          {fixed?.memo && (
            <div>
              <dt>Note</dt>
              <dd>{fixed.memo}</dd>
            </div>
          )}
          <div>
            <dt>Lightning needed</dt>
            {lightningRow ? (
              <dd>
                <span className="tabular">{lightningRow.value}</span>
                {lightningRow.sub && <span className={styles.ddSub}>{lightningRow.sub}</span>}
              </dd>
            ) : quote.status === "loading" ? (
              <dd>
                <Skeleton width={96} height={14} />
              </dd>
            ) : (
              <dd className={styles.ddMuted}>{quote.status === "expired" ? "Refresh to see the latest" : "Shown with a live price"}</dd>
            )}
          </div>
          <div>
            <dt>You pay with</dt>
            <dd>
              <span className={styles.inline}>
                <NimMark size={16} /> NIM
              </span>
            </dd>
          </div>
          <div>
            <dt>Final NIM debit</dt>
            <dd className={styles.ddMuted}>Shown by Nimiq Pay before you approve</dd>
          </div>
        </dl>

        <Notice tone="info" icon="shield" title="Lightning sats aren't your NIM cost">
          The price above is what the Lightning payment needs to deliver exactly {formatted} {destination.asset}. Nimiq Pay converts your NIM and shows the exact NIM
          amount before you approve. A price check isn&apos;t a guarantee.
        </Notice>
      </div>

      <div className={styles.swipeArea}>
        <SwipeToConfirm
          key={fresh ? "fresh" : "blocked"}
          label={fresh ? "Swipe to continue to approval" : quote.status === "loading" ? "Waiting for a live price" : "Needs a live price"}
          completedLabel="Continuing to approval"
          disabled={!fresh}
          onComplete={() => window.setTimeout(onApprove, 420)}
        />
        <button type="button" className={styles.tapAlt} onClick={onApprove} disabled={!fresh}>
          Can&apos;t swipe? Continue with a tap
        </button>
      </div>
    </div>
  );
}

function QuoteStatus({
  quote,
  unavailableReason,
  onBack,
  fixed,
}: {
  quote: ReturnType<typeof useLiveQuote>;
  unavailableReason: ReviewProps["unavailableReason"];
  onBack: () => void;
  fixed: boolean;
}): React.JSX.Element | null {
  if (quote.status === "idle") {
    if (unavailableReason === "preview") {
      return (
        <div className={styles.quoteBox}>
          <Notice tone="info" icon="eye" title="Live prices aren't shown in preview">
            Connect your wallet to check what this payment needs.
          </Notice>
        </div>
      );
    }
    if (unavailableReason === "checking") {
      return (
        <p className={styles.quoteLine} role="status">
          <Icon name="clock" size={14} /> Checking availability…
        </p>
      );
    }
    return (
      <div className={styles.quoteBox}>
        <Notice tone="warn" icon="alert" title="Not available right now">
          This currency can&apos;t be paid at the moment, so no price was checked. Try again later.
        </Notice>
      </div>
    );
  }
  if (quote.status === "loading") {
    return (
      <p className={styles.quoteLine} role="status" aria-live="polite">
        <span className={styles.quoteSpinner} aria-hidden="true" /> Checking the live price…
      </p>
    );
  }
  if (quote.status === "ready") {
    const warnings = quoteWarnings(quote.quote);
    return (
      <div className={styles.quoteBox}>
        <p className={styles.quoteLine} data-tone="ok" role="status">
          <Icon name="check" size={14} strokeWidth={2.6} /> Live price · valid for <span className="tabular">{quote.freshness.countdown}</span>
          <button type="button" className={styles.quoteRefresh} onClick={quote.refresh}>
            Refresh
          </button>
        </p>
        {warnings.map((w) => (
          <Notice key={w} tone="warn" icon="info">
            {w}
          </Notice>
        ))}
      </div>
    );
  }
  if (quote.status === "expired") {
    return (
      <div className={styles.quoteBox}>
        <Notice tone="warn" icon="clock" title="This price has expired" live>
          Prices only last a few minutes. Refresh to check the current price.
        </Notice>
        <Button variant="soft" size="md" icon="refresh" block onClick={quote.refresh}>
          Refresh price
        </Button>
      </div>
    );
  }
  const { problem } = quote;
  return (
    <div className={styles.quoteBox}>
      <Notice tone={problem.kind === "provider" || problem.kind === "busy" ? "warn" : "error"} icon="alert" title={problem.title} live>
        {problem.body}
      </Notice>
      {problem.retryable && (
        <Button variant="soft" size="md" icon="refresh" block onClick={quote.refresh}>
          Try again
        </Button>
      )}
      {problem.changeAmount && !fixed && (
        <Button variant="soft" size="md" icon="arrow-left" block onClick={onBack}>
          Change amount
        </Button>
      )}
    </div>
  );
}

type PreparationState = ReturnType<typeof usePreparation>["state"];

function HandoffStep({
  payeeName,
  amount,
  assetLabel,
  routeId,
  asset,
  requestPublicId,
  saveOffer,
  preparation,
  handoff,
  ownerUserId,
  sessionValid,
  previewMode,
  onRetry,
  onBack,
  onRequote,
  onAcceptReprice,
  onDone,
}: {
  payeeName: string;
  amount: string;
  assetLabel: string;
  routeId: import("@/domain/routes").RouteId;
  asset: string;
  requestPublicId: string | null;
  /** One-off payee worth offering to save on the receipt; null when N/A. */
  saveOffer: { address: string; routeId: import("@/domain/routes").RouteId } | null;
  preparation: PreparationState;
  handoff: ReturnType<typeof useHandoff>;
  ownerUserId: string | null;
  sessionValid: boolean;
  previewMode: boolean;
  onRetry: () => void;
  onBack: () => void;
  onRequote: () => void;
  onAcceptReprice: (acceptedSourceSats: string) => void;
  onDone: () => void;
}): React.JSX.Element {
  const router = useRouter();
  // Resume after app suspension/termination: authoritative server state only.
  useEffect(() => {
    if (preparation.phase === "ready" && preparation.transferId && ownerUserId) {
      void handoff.resume(preparation.transferId, ownerUserId, sessionValid, previewMode);
    }
    // Resume once per prepared transfer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preparation.phase === "ready" ? preparation.transferId : null]);
  const steps = timelineFor("AWAITING_NIM_APPROVAL");
  const recoveryNeedsActivity = preparation.phase === "failed" && preparation.issue.action === "resume";
  const working =
    preparation.phase === "working"
      ? preparation
      : preparation.phase === "idle"
        ? { step: "creating" as const, message: "Preparing your payment…" }
        : null;
  return (
    <div className={styles.handoffStep} key="handoff">
      <div className={styles.handoffScroll}>
        <div className={styles.handoffHero}>
          <span className={styles.handoffMark}>
            <NimMark size={40} />
          </span>
          <h2 className={styles.handoffTitle}>
            {preparation.phase === "ready"
              ? "Ready for Nimiq Pay approval"
              : preparation.phase === "failed"
                ? preparation.issue.title
                : "Preparing your payment"}
          </h2>
          <p className={styles.handoffBody}>
            {preparation.phase === "ready"
              ? payeeName + " will receive exactly " + amount + " " + assetLabel + ". No approval is recorded yet — Nimiq Pay shows the exact NIM amount before you approve."
              : preparation.phase === "failed"
                ? recoveryNeedsActivity
                  ? "This payment needs to be checked before continuing. Check Activity for its current status and do not resend it."
                  : "No payment outcome is confirmed. Your recovery information was kept so you can continue safely."
                : payeeName + " will receive exactly " + amount + " " + assetLabel + ". Getting everything ready so Nimiq Pay can ask for approval."}
          </p>
        </div>

        {working && (
          <div className={styles.quoteBox}>
            <p className={styles.quoteLine} role="status" aria-live="polite">
              <span className={styles.quoteSpinner} aria-hidden="true" /> {working.message}
            </p>
            <p className={styles.ctaNote}>
              <Icon name="lock" size={14} /> Saving recovery information on this device before approval. Browser storage is not automatically safe against clearing, device loss or snooping — that is why we check the save before continuing.
            </p>
          </div>
        )}

        {preparation.phase === "ready" && (
          <div className={styles.quoteBox}>
            <Notice tone="info" icon="shield" title="Prepared — not yet paid" live>
              A prepared payment is not a delivered payment. Approve it in Nimiq Pay next. Payment approval is part of the next step and has not happened here.
            </Notice>
            {preparation.sourceSats ? (
              <p className={styles.quoteLine} data-tone="ok">
                <Icon name="check" size={14} strokeWidth={2.6} /> Lightning needed: <span className="tabular">{preparation.sourceSats} sats</span>
              </p>
            ) : null}
            <Button
              variant="ink"
              block
              disabled={handoff.state.phase === "confirming"}
              onClick={() => {
                if (preparation.phase !== "ready" || !ownerUserId) return;
                void handoff.invoke({
                  transferId: preparation.transferId,
                  authorizedInvoice: preparation.invoiceBolt11 ?? "",
                  sourceSats: preparation.sourceSats,
                  ownerUserId,
                  sessionValid,
                  previewMode,
                });
              }}
            >
              {handoff.state.phase === "confirming" ? "Waiting for Nimiq Pay…" : "Confirm in Nimiq Pay"}
            </Button>
            <p className={styles.ctaNote}>
              {(!isPaymentFlagEnabled() || previewMode) ? (
                <>
                  <Icon name="lock" size={14} /> Payments are paused in this preview — no native payment call was made. Nimiq Pay would show the exact NIM amount before you approve.
                </>
              ) : (
                <>
                  <Icon name="lock" size={14} /> Nimiq Pay shows the exact NIM amount before you approve. The debit happens only after you confirm there.
                </>
              )}
            </p>
            {handoff.state.transferId === preparation.transferId && handoff.state.phase === "confirming" && (
              <p className={styles.quoteLine} role="status" aria-live="polite">
                <span className={styles.quoteSpinner} aria-hidden="true" /> {handoff.state.message}
              </p>
            )}
            {handoff.state.transferId === preparation.transferId && handoff.state.phase === "checking" && (
              <Notice tone="warn" icon="clock" title="Payment being checked" live>
                {handoff.state.message}
              </Notice>
            )}
            {handoff.state.transferId === preparation.transferId && handoff.state.phase === "cancelled" && (
              <Notice tone="info" icon="check" title="Payment cancelled" live>
                {handoff.state.message}
              </Notice>
            )}
            {handoff.state.transferId === preparation.transferId && handoff.state.phase === "attention" && (
              <Notice tone="warn" icon="alert" title="Payment needs attention" live>
                {handoff.state.message}
              </Notice>
            )}
          </div>
        )}

        {preparation.phase === "ready" && preparation.transferId && ownerUserId && (
          <SettlementProgress
            transferId={preparation.transferId}
            ownerUserId={ownerUserId}
            requestPublicId={requestPublicId}
            sessionValid={sessionValid}
            previewMode={previewMode}
            routeId={routeId}
            asset={asset}
            saveOffer={saveOffer}
          />
        )}

        {preparation.phase === "failed" && (
          <div className={styles.quoteBox}>
            <Notice tone={preparation.issue.action === "abort" ? "error" : "warn"} icon="alert" title={preparation.issue.title} live>
              {preparation.issue.body}
            </Notice>
            {preparation.issue.action === "reauth" ? (
              <Button variant="ink" block onClick={() => router.push("/app/setup")}>
                Sign in again
              </Button>
            ) : preparation.issue.action === "requote" ? (
              <Button variant="soft" size="md" icon="refresh" block onClick={onRequote}>
                Refresh the price &amp; continue
              </Button>
            ) : preparation.issue.action === "accept-reprice" && preparation.issue.reprice ? (
              <RepriceAcceptance
                payeeName={payeeName}
                amount={amount}
                assetLabel={assetLabel}
                quotedSourceSats={preparation.issue.reprice.quotedSourceSats}
                liveSourceSats={preparation.issue.reprice.liveSourceSats}
                onAccept={() => onAcceptReprice(preparation.issue.reprice?.liveSourceSats ?? "")}
              />
            ) : recoveryNeedsActivity ? (
              <Button variant="soft" size="md" icon="arrow-right" block onClick={() => router.push("/app/activity")}>
                Check Activity
              </Button>
            ) : preparation.issue.retryable ? (
              <Button variant="soft" size="md" icon="refresh" block onClick={onRetry}>
                Try again
              </Button>
            ) : null}
            <p className={styles.ctaNote}>
              {recoveryNeedsActivity ? "Do not resend while this payment is being checked." : "Checking payment — do not resend while a step is in progress."}
            </p>
          </div>
        )}

        <div className={styles.next}>
          <p className={styles.nextTitle}>What happens after you approve</p>
          <Timeline steps={steps} />
        </div>
      </div>

      <div className={styles.handoffActions}>
        <Button variant="soft" onClick={onBack}>
          Back to review
        </Button>
        <Button variant="ink" onClick={onDone}>
          Done
        </Button>
      </div>
    </div>
  );
}

/**
 * Explicit refreshed-price acceptance (F8.12): the swap now costs more
 * sats than locked. Shows old vs new cost and the unchanged recipient
 * amount, and continues only on an explicit tap with the exact reviewed
 * figure. Nimiq Pay still shows the final NIM debit before approval.
 */
function RepriceAcceptance({
  payeeName,
  amount,
  assetLabel,
  quotedSourceSats,
  liveSourceSats,
  onAccept,
}: {
  payeeName: string;
  amount: string;
  assetLabel: string;
  quotedSourceSats: string;
  liveSourceSats: string;
  onAccept: () => void;
}): React.JSX.Element {
  let delta: string | null = null;
  try {
    const d = BigInt(liveSourceSats) - BigInt(quotedSourceSats);
    if (d > 0n) delta = d.toString();
  } catch {
    delta = null;
  }
  return (
    <div className={styles.quoteBox}>
      <p className={styles.quoteLine}>
        Quoted cost: <span className="tabular">{quotedSourceSats} sats</span>
      </p>
      <p className={styles.quoteLine} data-tone="ok">
        New cost: <span className="tabular">{liveSourceSats} sats</span>
        {delta !== null ? <span> (+{delta} sats in network fees)</span> : null}
      </p>
      <p className={styles.ctaNote}>
        {payeeName} still receives exactly {amount} {assetLabel} — only the Lightning cost moved. Nimiq Pay shows the exact NIM debit before you approve.
      </p>
      <div style={{ marginTop: 8 }}>
        <Button variant="ink" block onClick={onAccept}>
          Accept {liveSourceSats} sats &amp; continue
        </Button>
      </div>
    </div>
  );
}
