"use client";

import type { ReactNode } from "react";
import { isOperator, OPERATORS, formatFixed, groupOperand, type CalcKey, type CalcTokens, type Digit, type Evaluation, type Operator } from "@/ui/lib/calculator";
import { cn } from "@/ui/lib/cn";
import { Icon } from "./Icon";
import styles from "./amount.module.css";

const OPERATOR_LABEL: Record<Operator, string> = { "+": "Plus", "−": "Minus", "×": "Times", "÷": "Divided by" };
const DIGITS: Digit[] = ["1", "2", "3", "4", "5", "6", "7", "8", "9"];

interface AmountDisplayProps {
  tokens: CalcTokens;
  asset: string;
  decimals: number;
  evaluation: Evaluation;
  /** Changes on every accepted digit; re-keys the last glyph so it rolls in. */
  inputNonce: number;
  animateLast: boolean;
  /** Changes on every rejected key; triggers a short shake. */
  shakeNonce: number;
  onCommit: () => void;
  caption: ReactNode;
  captionTone: "muted" | "error" | "note";
}

function sizeFor(length: number): "xl" | "lg" | "md" | "sm" {
  if (length <= 7) return "xl";
  if (length <= 10) return "lg";
  if (length <= 14) return "md";
  return "sm";
}

export function AmountDisplay({ tokens, asset, decimals, evaluation, inputNonce, animateLast, shakeNonce, onCommit, caption, captionTone }: AmountDisplayProps): React.JSX.Element {
  const rendered = tokens.map((t) => (isOperator(t) ? t : groupOperand(t)));
  const length = rendered.join(" ").length;
  const last = rendered[rendered.length - 1] ?? "";
  const showResult = evaluation.kind === "value" && evaluation.isExpression;
  const spoken = tokens.length === 0 ? `0 ${asset}` : `${tokens.join(" ")} ${asset}`;

  return (
    <div className={styles.display}>
      <output className={styles.value} data-size={sizeFor(length)} aria-label={`Amount: ${spoken}`} key={`shake-${shakeNonce}`} data-shake={shakeNonce > 0}>
        {tokens.length === 0 ? (
          <span className={styles.placeholder}>0</span>
        ) : (
          rendered.map((token, i) => {
            const isLast = i === rendered.length - 1;
            if (isOperator(tokens[i])) {
              return (
                <span key={i} className={cn(styles.op, isLast && animateLast && styles.charIn)}>
                  {token}
                </span>
              );
            }
            if (!isLast || !animateLast) return <span key={i}>{token}</span>;
            return (
              <span key={i}>
                {last.slice(0, -1)}
                <span key={inputNonce} className={styles.charIn}>
                  {last.slice(-1)}
                </span>
              </span>
            );
          })
        )}
        <span className={styles.asset}>{asset}</span>
      </output>

      <div className={styles.resultSlot}>
        {showResult && evaluation.kind === "value" && (
          <button type="button" className={styles.result} onClick={onCommit} aria-label={`Use result: ${evaluation.value} ${asset}`}>
            = {formatFixed(evaluation.value, decimals)}
          </button>
        )}
      </div>

      <p className={styles.caption} data-tone={captionTone} aria-live="polite">
        {caption}
      </p>
    </div>
  );
}

export function Keypad({ onKey, disabled = false }: { onKey: (key: CalcKey) => void; disabled?: boolean }): React.JSX.Element {
  return (
    <div className={styles.keypad}>
      <div className={styles.operators} role="group" aria-label="Calculator operations">
        {OPERATORS.map((op) => (
          <button key={op} type="button" className={styles.opKey} aria-label={OPERATOR_LABEL[op]} onClick={() => onKey(op)} disabled={disabled}>
            {op}
          </button>
        ))}
      </div>
      <div className={styles.tray} role="group" aria-label="Number pad">
        {DIGITS.map((d) => (
          <button key={d} type="button" className={styles.key} onClick={() => onKey(d)} disabled={disabled}>
            {d}
          </button>
        ))}
        <button type="button" className={styles.key} aria-label="Decimal point" onClick={() => onKey(".")} disabled={disabled}>
          .
        </button>
        <button type="button" className={styles.key} onClick={() => onKey("0")} disabled={disabled}>
          0
        </button>
        <button type="button" className={styles.key} aria-label="Delete" onClick={() => onKey("back")} disabled={disabled}>
          <Icon name="backspace" size={24} strokeWidth={1.8} />
        </button>
      </div>
    </div>
  );
}
