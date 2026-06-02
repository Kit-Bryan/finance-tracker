import { Suspense } from "react";
import TransactionsContent from "./TransactionsContent";

export default function TransactionsPage() {
  return (
    <Suspense fallback={<div style={{ padding: 40, color: "var(--text-muted)", fontSize: 13 }}>Loading...</div>}>
      <TransactionsContent />
    </Suspense>
  );
}
