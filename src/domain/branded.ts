/**
 * Zero-runtime-cost branded identifier types.
 *
 * Every identifier in Pluts — account ids, entry ids, amount-line ids,
 * idempotency keys — is a `string` at runtime, but they are *not*
 * interchangeable: passing an account id where an entry id is expected
 * typechecks silently today, and a hand-built `Entry`/`Account` can carry any
 * field combination. These brands make such swaps a compile error while
 * leaving the emitted JavaScript untouched — a brand is a phantom property, so
 * the underlying value is still just a string and costs nothing at runtime.
 *
 * Brand only at the trust boundary. Repositories mint ids from
 * `crypto.randomUUID()` and wrap them with the `to*` helpers below; callers
 * receive branded values back and cannot fabricate one without going through a
 * helper. That is the point: a caller holding a branded id has, by
 * construction, obtained it from the ledger.
 */

export type AccountId = string & { readonly __brand: "AccountId" };
export type EntryId = string & { readonly __brand: "EntryId" };
export type AmountLineId = string & { readonly __brand: "AmountLineId" };
export type IdempotencyKey = string & { readonly __brand: "IdempotencyKey" };

/**
 * A date string carried by the ledger's persisted records — an entry's
 * transaction date or posting timestamp, an account's created-at. Produced by
 * {@link toDateISO}; branding it means a posting date can never be confused
 * with an account id, an entry id, or any other identifier.
 */
export type ISODate = string & { readonly __brand: "ISODate" };

export function toAccountId(id: string): AccountId {
  return id as AccountId;
}

export function toEntryId(id: string): EntryId {
  return id as EntryId;
}

export function toAmountLineId(id: string): AmountLineId {
  return id as AmountLineId;
}

export function toIdempotencyKey(key: string): IdempotencyKey {
  return key as IdempotencyKey;
}
