"use client";

import { useReducer } from "react";
import { commit, press, type CalcKey, type CalcRejection, type CalcTokens } from "@/ui/lib/calculator";

interface CalcState {
  tokens: CalcTokens;
  inputNonce: number;
  shakeNonce: number;
  animateLast: boolean;
  rejection: CalcRejection | null;
}

type CalcAction = { type: "key"; key: CalcKey; decimals: number } | { type: "commit"; decimals: number } | { type: "reset" };

const INITIAL: CalcState = { tokens: [], inputNonce: 0, shakeNonce: 0, animateLast: false, rejection: null };

function reducer(state: CalcState, action: CalcAction): CalcState {
  switch (action.type) {
    case "reset":
      return { ...INITIAL, inputNonce: state.inputNonce };
    case "commit":
      return { ...state, tokens: commit(state.tokens, action.decimals), animateLast: false, rejection: null };
    case "key": {
      const result = press(state.tokens, action.key, action.decimals);
      if (result.rejected) return { ...state, rejection: result.rejected, shakeNonce: state.shakeNonce + 1, animateLast: false };
      const typed = action.key !== "back" && action.key !== "clear";
      return {
        ...state,
        tokens: result.tokens,
        rejection: null,
        animateLast: typed,
        inputNonce: state.inputNonce + 1,
      };
    }
  }
}

export function useCalculator() {
  return useReducer(reducer, INITIAL);
}
