interface HandoffOrder { id: string; nimAddress: string; nimLuna: string; memo: string }
/** The server grants exactly one prompt attempt. An unknown outcome is recovery, never a retry. */
export async function handoffDeskPayment(input: {
  authorize: () => Promise<{ order: HandoffOrder; promptAllowed: boolean }>;
  send: (tx: { recipient: string; value: number; data: string }) => Promise<string>;
  saveHash: (id: string, hash: string) => void;
  report: (id: string, hash: string) => Promise<unknown>;
}) {
  const authorized = await input.authorize();
  if (!authorized.promptAllowed) return;
  const value = Number(authorized.order.nimLuna);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error("Invalid wallet amount. Do not pay again.");
  const hash = await input.send({ recipient: authorized.order.nimAddress, value, data: authorized.order.memo });
  // Some old hosts return serialized bytes. Never mistake them for a transaction hash.
  if (!/^(0x)?[0-9a-f]{64}$/i.test(hash)) throw new Error("The wallet result needs checking. Do not pay again.");
  input.saveHash(authorized.order.id, hash);
  await input.report(authorized.order.id, hash);
}
