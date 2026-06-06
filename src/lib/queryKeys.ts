export const QK = {
  transactions: (filters: Record<string, string | number | boolean>) => ['transactions', filters] as const,
  insights: (from: string, to: string) => ['insights', from, to] as const,
  recentTx: (from: string, to: string) => ['recent-tx', from, to] as const,
  categories: () => ['categories'] as const,
  categoriesManage: () => ['categories-manage'] as const,
  accounts: () => ['accounts'] as const,
  batches: () => ['import-batches'] as const,
  trash: () => ['trash'] as const,
  flags: () => ['flags'] as const,
};
