/**
 * Strict allowlist classifier for Nimiq Pay `payLightningInvoice` failures.
 *
 * Nimiq Pay forwards the host error class `type` plus a human message. The
 * message is the only thing that tells the failure sites apart (e.g. the
 * 2026-11-12 transfer 821ae86c INVALID_TRANSACTION could have been any of ~12
 * sites), but it is free text and must never be logged or stored. This module
 * maps EXACT, documented upstream messages onto a bounded reason code; anything
 * else becomes UNRECOGNIZED. Only the code ever leaves the client.
 *
 * Source of truth: github.com/nimiq/nimiq-pay-app @ 5c0485f (2026-11-11);
 * the Lightning path is unchanged since release 2.23.0.
 *   - src/composables/useMiniAppHost.ts  `payLightningInvoice` (literal English)
 *   - src/composables/useStringParser.ts `parseBitcoinLightningUrl` (i18n)
 *   - src/lib/tx.ts / src/stores/polygon-usdt.ts send rejections (i18n)
 *   - src/i18n/{de,es,fr,pt}.po translations of the i18n strings (empty msgstr
 *     falls back to English, so English is always accepted)
 *
 * Diagnostics only: a reason code never changes the payment outcome, the
 * unknown/reconciling path or any replay protection.
 *
 * Pure module (no imports) so the browser client and the server schema share
 * one enum.
 */

export const NIMIQ_PAY_FAILURE_REASONS = [
  // INVALID_TRANSACTION — all raised before broadcast or on an explicit pre-broadcast rejection.
  "INVOICE_EXPIRED",
  "INVOICE_INVALID",
  "INVOICE_WRONG_NETWORK",
  "SWAP_CREATE_FAILED",
  "SWAP_QUOTE_FETCH_FAILED",
  "SWAP_QUOTE_INVALID",
  "SWAP_PREPARE_FAILED",
  "SWAP_QUOTE_EXPIRED",
  "INSUFFICIENT_NIM_BALANCE",
  "INSUFFICIENT_USDT_BALANCE",
  "SWAP_LIMIT_EXCEEDED",
  "USDT_MAINTENANCE",
  "SEND_REJECTED",
  // DUPLICATE_PAYMENT
  "DUPLICATE_IN_FLIGHT",
  "DUPLICATE_ALREADY_SUBMITTED",
  // TRANSACTION_OUTCOME_UNKNOWN
  "OUTCOME_UNKNOWN",
  "SUBMITTED_RECORD_NOT_SAVED",
  // A classified type whose message is missing, malformed, or not on the allowlist.
  "UNRECOGNIZED",
] as const;

export type NimiqPayFailureReason = (typeof NIMIQ_PAY_FAILURE_REASONS)[number];

/** Host error types this classifier understands; every other type yields null (the type alone is logged). */
export const CLASSIFIED_NIMIQ_PAY_TYPES = ["INVALID_TRANSACTION", "DUPLICATE_PAYMENT", "TRANSACTION_OUTCOME_UNKNOWN"] as const;

type Rule = { reason: NimiqPayFailureReason; exact?: readonly string[]; prefix?: readonly string[] };

/** i18n'd upstream strings: English msgid first, then de/es/fr/pt msgstr where translated. */
const T = {
  invoiceExpired: ["Bitcoin Lightning invoice expired.", "Bitcoin-Lightning-Rechnung (Invoice) abgelaufen.", "La factura de Bitcoin Lightning ha expirado.", "La facture Bitcoin Lightning a expiré.", "Fatura Bitcoin Lightning expirada."],
  missingTimestamp: ["Invalid Bitcoin Lightning invoice: missing timestamp.", "Ungültige Bitcoin-Lightning-Rechnung (Invoice): Erstellungszeitpunkt fehlt.", "Factura de Bitcoin Lightning no válida: falta la marca de tiempo.", "Facture Bitcoin Lightning invalide : date et heure manquantes.", "Fatura Bitcoin Lightning inválida: carimbo de data/hora em falta."],
  missingAmount: ["Invalid Bitcoin Lightning invoice: missing amount.", "Ungültige Bitcoin-Lightning-Rechnung (Invoice): Betrag fehlt.", "Factura de Bitcoin Lightning no válida: falta el monto.", "Facture Bitcoin Lightning invalide : montant manquant.", "Fatura Bitcoin Lightning inválida: valor em falta."],
  // Followed by " Error: <decoder message>" upstream — matched as a prefix, suffix discarded.
  invalidInvoice: ["Invalid Bitcoin Lightning invoice.", "Ungültige Bitcoin-Lightning-Rechnung (Invoice).", "Factura de Bitcoin Lightning no válida.", "Facture Bitcoin Lightning invalide.", "Fatura Bitcoin Lightning inválida."],
  // Followed by ' Expected "bc", got "..."' upstream — matched as a prefix.
  wrongNetwork: ["Wrong network in Bitcoin Lightning invoice.", "Die Bitcoin-Lightning-Rechnung (Invoice) bezieht sich auf ein anderes Netzwerk.", "Red incorrecta en la factura de Bitcoin Lightning.", "Mauvais réseau dans la facture Bitcoin Lightning.", "Rede errada na fatura Bitcoin Lightning."],
  cannotCreateSwap: ["Cannot create swap", "Tausch konnte nicht erstellt werden", "No se puede crear el intercambio", "Impossible de créer le swap", "Não é possível criar a troca"],
  cannotFetchSwap: ["Cannot fetch existing swap", "Bestehender Tausch konnte nicht abgerufen werden", "No se puede obtener el intercambio existente", "Impossible de récupérer le swap existant", "Não é possível obter a troca existente"],
  cannotFetchAmount: ["Could not fetch amount for Bitcoin Lightning swap.", "Betrag für Bitcoin-Lightning-Tausch konnte nicht abgerufen werden.", "No se ha podido obtener el importe para el intercambio de Bitcoin Lightning.", "Impossible de récupérer le montant du swap Bitcoin Lightning.", "Não foi possível obter o valor para a troca de Bitcoin Lightning."],
  // Send-path rejections (tx.ts NIM, polygon-usdt.ts USDT): nothing was broadcast.
  sendRejected: [
    "Something went wrong syncing your account", "Etwas ist beim Abruf deines Kontos schiefgelaufen", "Algo salió mal sincronizando tu cuenta", "Un problème est survenu lors de la synchronisation de votre compte", "Alguma coisa deu errado ao sincronizar com a tua conta",
    "Invalid swap hash", "Ungültiger Hash-Wert für den Tausch", "Hash de intercambio inválido", "Hash su swap invalide", "Hash de troca inválido",
    "No NIM HTLC found in swap", "Es wurde kein NIM-HTLC für den Tausch gefunden", "No se encontró ningún HTLC de NIM en el intercambio", "Aucun HTLC NIM n'a été trouvé dans le swap", "Nenhum HTLC de NIM encontrado na troca",
    "Invalid NIM HTLC data in swap", "Ungültige NIM-HTLC-Daten für den Tausch", "Datos del HTLC de NIM inválidos en el intercambio", "Données NIM HTLC non valides dans le swap", "Dados do HTLC de NIM inválidos na troca",
    "No account has been created yet, or it is currently processing funds", "Es wurde noch kein Konto angelegt oder es wird aktuell Guthaben verarbeitet", "Todavía no se ha creado ninguna cuenta o actualmente se están procesando fondos", "Aucun compte n'a encore été créé, ou les fonds sont en cours de traitement", "Ainda não foi encontrada uma conta ou está atualmente a processar fundos",
    "Invalid transfer type", "Ungültige Transferart", "Tipo de transferencia inválido", "Type de transfert non valide", "Tipo de transferência inválido",
    "Network ID mismatch", "Netzwerk-ID stimmt nicht überein", "El ID de red no coincide", "Identifiant de réseau incohérent", "Incompatibilidade de ID da rede",
    "No account has been found", "Es wurde kein Konto gefunden", "No se ha encontrado ninguna cuenta", "Aucun compte n'a été trouvé", "Nenhuma conta foi encontrada",
    "No USDT HTLC found in swap", "Es wurde kein USDT-HTLC für den Tausch gefunden", "No se ha encontrado ningún HTLC de USDT en el intercambio", "Aucun HTLC USDT n'a été trouvé dans le swap", "Nenhum HTLC de USDT encontrado na troca",
    "Wallet changed before sending", // untranslated upstream
    "Polygon Lightning payment rejected", // literal fallback in useMiniAppHost
  ],
} as const;

const RULES: Record<(typeof CLASSIFIED_NIMIQ_PAY_TYPES)[number], readonly Rule[]> = {
  INVALID_TRANSACTION: [
    { reason: "INVOICE_EXPIRED", exact: ["Bitcoin Lightning invoice expired", ...T.invoiceExpired] },
    { reason: "INVOICE_INVALID", exact: [...T.missingTimestamp, ...T.missingAmount], prefix: T.invalidInvoice.map((s) => `${s} `) },
    { reason: "INVOICE_WRONG_NETWORK", prefix: T.wrongNetwork.map((s) => `${s} `) },
    { reason: "SWAP_CREATE_FAILED", exact: T.cannotCreateSwap },
    { reason: "SWAP_QUOTE_FETCH_FAILED", exact: T.cannotFetchSwap },
    { reason: "SWAP_QUOTE_INVALID", exact: T.cannotFetchAmount },
    { reason: "SWAP_PREPARE_FAILED", exact: ["Could not prepare a NIM to Bitcoin Lightning swap", "Could not prepare a USDT to Bitcoin Lightning swap"] },
    { reason: "SWAP_QUOTE_EXPIRED", exact: ["The Lightning swap quote expired; request a new invoice"] },
    { reason: "INSUFFICIENT_NIM_BALANCE", exact: ["Insufficient NIM balance"] },
    { reason: "INSUFFICIENT_USDT_BALANCE", exact: ["Insufficient USDT balance for payment and fee"] },
    { reason: "SWAP_LIMIT_EXCEEDED", exact: ["Lightning swap exceeds the current limit"] },
    // Default notice only; a remotely configured maintenance text stays UNRECOGNIZED.
    { reason: "USDT_MAINTENANCE", exact: ["USDT payments are temporarily unavailable due to maintenance. Please try again later."] },
    { reason: "SEND_REJECTED", exact: T.sendRejected },
  ],
  DUPLICATE_PAYMENT: [
    { reason: "DUPLICATE_IN_FLIGHT", exact: ["This Lightning invoice is already being paid"] },
    { reason: "DUPLICATE_ALREADY_SUBMITTED", exact: ["This Lightning invoice was already submitted or may still be pending"] },
  ],
  TRANSACTION_OUTCOME_UNKNOWN: [
    { reason: "OUTCOME_UNKNOWN", exact: ["Lightning payment outcome is unknown. Do not retry this invoice."] },
    {
      reason: "SUBMITTED_RECORD_NOT_SAVED",
      exact: [
        "NIM was submitted, but its payment record could not be updated. Do not retry this invoice.",
        "USDT was submitted, but its payment record could not be updated. Do not retry this invoice.",
      ],
    },
  ],
};

/** Upstream messages are short; anything longer is not one of them. */
const MAX_MESSAGE_LENGTH = 300;

function isClassifiedType(type: string): type is (typeof CLASSIFIED_NIMIQ_PAY_TYPES)[number] {
  return (CLASSIFIED_NIMIQ_PAY_TYPES as readonly string[]).includes(type);
}

/**
 * Map a host error onto a bounded reason code.
 * - Unclassified or non-string `type` → null (nothing to add beyond the type).
 * - Classified type with a missing/malformed/unknown message → "UNRECOGNIZED".
 * Matching is exact (after trimming surrounding whitespace) or, for the two
 * upstream sentences that carry a dynamic tail, a fixed-sentence prefix.
 * The message itself is never returned, stored or logged.
 */
export function classifyNimiqPayFailure(type: unknown, message: unknown): NimiqPayFailureReason | null {
  if (typeof type !== "string" || !isClassifiedType(type)) return null;
  if (typeof message !== "string" || message.length === 0 || message.length > MAX_MESSAGE_LENGTH) return "UNRECOGNIZED";
  const text = message.trim();
  for (const rule of RULES[type]) {
    if (rule.exact?.includes(text)) return rule.reason;
    if (rule.prefix?.some((p) => text.startsWith(p))) return rule.reason;
  }
  return "UNRECOGNIZED";
}

export function isNimiqPayFailureReason(value: unknown): value is NimiqPayFailureReason {
  return typeof value === "string" && (NIMIQ_PAY_FAILURE_REASONS as readonly string[]).includes(value);
}
