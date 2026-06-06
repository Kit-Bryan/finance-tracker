export interface ImportProfile {
  id?: number;
  name: string;
  bank: string;
  config: ProfileConfig;
}

export interface ProfileConfig {
  // CSV column names (case-insensitive match)
  dateColumn: string;
  // Optional separate time column (omit if the date column already contains a time, or there's no time)
  timeColumn?: string;
  descriptionColumn: string;
  amountColumn: string;
  // If separate debit/credit columns instead of signed amount
  debitColumn?: string;
  creditColumn?: string;
  // Date parsing format (e.g. "MM/DD/YYYY", "YYYY-MM-DD", "DD/MM/YYYY")
  dateFormat: string;
  // When debitColumn is used: is debit a positive or negative number in the source?
  debitIsPositive?: boolean;
  // Skip N header rows beyond the detected header row
  skipRows?: number;
  // Currency override (if the file doesn't include one)
  currency?: string;
  // CSV delimiter (defaults to comma)
  delimiter?: string;
}

export interface ParsedRow {
  date: Date;
  description: string;
  amount: number; // negative = expense, positive = income
  currency: string;
  rawRow: Record<string, string>;
  fingerprint: string;
  parseError?: string;
}
