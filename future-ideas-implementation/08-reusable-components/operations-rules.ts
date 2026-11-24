/**
 * Provider-independent rule helpers for a future Operations Autopilot.
 * This file is intentionally not imported by the production Worker.
 * Keep calculations deterministic and test them before integration.
 */

export type Severity = "critical" | "warning" | "info";

export interface StockSignal {
  ingredientId: string;
  onHandBaseUnits: number;
  reorderPointBaseUnits: number;
  unitLabel: string;
}

export interface RuleFinding {
  ruleKey: string;
  severity: Severity;
  title: string;
  explanation: string;
  evidence: Record<string, string | number>;
}

export function detectLowStock(signal: StockSignal): RuleFinding | null {
  const values = [
    signal.onHandBaseUnits,
    signal.reorderPointBaseUnits,
  ];
  if (!values.every(Number.isFinite) || signal.onHandBaseUnits < 0 ||
      signal.reorderPointBaseUnits < 0) {
    throw new Error("Stock quantities must be finite and non-negative");
  }

  if (signal.onHandBaseUnits > signal.reorderPointBaseUnits) return null;

  return {
    ruleKey: "inventory.low-stock",
    severity: signal.onHandBaseUnits === 0 ? "critical" : "warning",
    title: signal.onHandBaseUnits === 0 ? "Ingredient out of stock" : "Ingredient at reorder point",
    explanation: `On-hand quantity is ${signal.onHandBaseUnits} ${signal.unitLabel}; reorder point is ${signal.reorderPointBaseUnits} ${signal.unitLabel}.`,
    evidence: {
      ingredientId: signal.ingredientId,
      onHandBaseUnits: signal.onHandBaseUnits,
      reorderPointBaseUnits: signal.reorderPointBaseUnits,
      unitLabel: signal.unitLabel,
    },
  };
}

export interface PurchaseVariance {
  orderedQuantity: number;
  receivedQuantity: number;
}

export function calculateReceivingVariance(input: PurchaseVariance): {
  difference: number;
  shortReceived: boolean;
  overReceived: boolean;
} {
  if (!Number.isFinite(input.orderedQuantity) ||
      !Number.isFinite(input.receivedQuantity) ||
      input.orderedQuantity < 0 || input.receivedQuantity < 0) {
    throw new Error("Purchase quantities must be finite and non-negative");
  }

  const difference = input.receivedQuantity - input.orderedQuantity;
  return {
    difference,
    shortReceived: difference < 0,
    overReceived: difference > 0,
  };
}
