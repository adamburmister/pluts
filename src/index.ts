export {
  type AccountTotals,
  type AccountTotalsOptions,
  type EntryCursor,
  type EntryPageOptions,
  type EntryWalkOptions,
  entryCursor,
  type Repository,
} from "./db/repository.js";
export {
  getLedgerMeta,
  type LedgerMeta,
  migrate,
  SCHEMA_SQL,
  SCHEMA_STATEMENTS,
  SCHEMA_VERSION,
} from "./db/schema.js";
export {
  fromStorageInt,
  SqlStorageRepository,
  toStorageInt,
} from "./db/sqlite-storage-repository.js";
export {
  Account,
  aggregateBalances,
  computeBalance,
} from "./domain/account.js";
export { Amount, formatAmount, SCALE } from "./domain/amount.js";
export {
  type AccountDTO,
  type AmountLineDTO,
  type EntryDTO,
  toAccountDTO,
  toAmountLineDTO,
  toEntryDTO,
} from "./domain/dto.js";
export {
  type AmountKind,
  AmountRecord,
  amountsFromPayload,
  assertBalanced,
  buildEntry,
  computeEntryFingerprint,
  Entry,
  type EntryPayload,
  type ResolvedAmountLine,
} from "./domain/entry.js";
export {
  IdempotencyConflictError,
  RepositoryError,
  ValidationError,
  type ValidationIssue,
} from "./domain/errors.js";
export {
  type BalanceSheet,
  type IncomeStatement,
  Ledger,
  type LedgerOptions,
  type TrialBalanceReport,
  type TrialBalanceRow,
} from "./domain/ledger.js";
// Only the hand-written input interfaces are public. The zod schemas that
// validate them (and `toIssues`, which maps `z.ZodIssue`s) are an
// implementation detail, deliberately kept off the API surface so a zod major
// bump is not a breaking change for consumers (issue #32).
export type {
  AmountInput,
  CreateAccountInput,
  EntryInput,
} from "./domain/schemas.js";
export {
  ACCOUNT_TYPES,
  AccountType,
  type DateRange,
  isValidISODate,
  normalCreditBalance,
  toDateISO,
  todayInTimeZone,
  utcToday,
} from "./domain/types.js";
