export { Amount, formatAmount, SCALE } from './domain/amount.js';
export {
  Account,
  aggregateBalances,
  computeBalance,
} from './domain/account.js';
export {
  AmountRecord,
  Entry,
  amountsFromPayload,
  buildEntry,
  type AmountKind,
  type EntryPayload,
  type ResolvedAmountLine,
} from './domain/entry.js';
export {
  Ledger,
  type BalanceSheet,
  type IncomeStatement,
} from './domain/ledger.js';
export {
  ACCOUNT_TYPES,
  AccountType,
  normalCreditBalance,
  type CommercialDocumentRef,
  type DateRange,
  toDateISO,
} from './domain/types.js';
export { RepositoryError, ValidationError, type ValidationIssue } from './domain/errors.js';
export {
  amountSchema,
  createAccountSchema,
  dateRangeSchema,
  entryInputSchema,
  toIssues,
  type AmountInput,
  type CreateAccountInput,
  type EntryInput,
} from './domain/schemas.js';
export type { Repository } from './db/repository.js';
export { SqlStorageRepository } from './db/sqlite-storage-repository.js';
export { SCHEMA_SQL, SCHEMA_STATEMENTS, migrateSql } from './db/schema.js';
