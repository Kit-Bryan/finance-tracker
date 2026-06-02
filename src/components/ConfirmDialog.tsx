"use client";

import { createPortal } from "react-dom";
import { useEffect, useState } from "react";

interface Props {
  open: boolean;
  title: string;
  description?: string;
  confirmLabel?: string;
  confirmColor?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export default function ConfirmDialog({
  open, title, description, confirmLabel = "Confirm", confirmColor = "var(--expense)",
  onConfirm, onCancel,
}: Props) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);

  if (!open || !mounted) return null;

  return createPortal(
    <>
      <div onClick={onCancel} style={{ position: "fixed", inset: 0, background: "#00000066", zIndex: 200 }} />
      <div style={{
        position: "fixed",
        top: "50%", left: "50%",
        transform: "translate(-50%, -50%)",
        zIndex: 201,
        background: "var(--bg-2)",
        border: "1px solid var(--border-2)",
        borderRadius: 10,
        padding: "24px 28px",
        width: 340,
        boxShadow: "0 16px 48px #00000066",
      }}>
        <div style={{ fontSize: 16, fontWeight: 700, color: "var(--text)", marginBottom: description ? 8 : 20, fontFamily: "var(--font-syne)" }}>
          {title}
        </div>
        {description && (
          <div style={{ fontSize: 13, color: "var(--text-muted)", marginBottom: 20, lineHeight: 1.5 }}>
            {description}
          </div>
        )}
        <div style={{ display: "flex", gap: 10 }}>
          <button onClick={onConfirm} style={{
            flex: 1, padding: "9px", borderRadius: 6, border: "none",
            background: confirmColor, color: "#fff", fontSize: 13, fontWeight: 600, cursor: "pointer",
          }}>
            {confirmLabel}
          </button>
          <button onClick={onCancel} style={{
            flex: 1, padding: "9px", borderRadius: 6,
            border: "1px solid var(--border-2)", background: "transparent",
            color: "var(--text-muted)", fontSize: 13, cursor: "pointer",
          }}>
            Cancel
          </button>
        </div>
      </div>
    </>,
    document.body
  );
}
