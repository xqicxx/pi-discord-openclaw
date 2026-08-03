// Lane delivery state tracker — ported from openclaw lane-delivery-state.ts (对照遗漏 #7).
// 跟踪 lane 投递状态：已投递 / 非静默跳过 / 非静默失败。

export type LaneDeliverySnapshot = {
  delivered: boolean;
  skippedNonSilent: number;
  failedNonSilent: number;
};

export type LaneDeliveryStateTracker = {
  markDelivered: () => void;
  markNonSilentSkip: () => void;
  markNonSilentFailure: () => void;
  snapshot: () => LaneDeliverySnapshot;
};

export function createLaneDeliveryStateTracker(): LaneDeliveryStateTracker {
  const state: LaneDeliverySnapshot = {
    delivered: false,
    skippedNonSilent: 0,
    failedNonSilent: 0,
  };
  return {
    markDelivered: () => {
      state.delivered = true;
    },
    markNonSilentSkip: () => {
      state.skippedNonSilent += 1;
    },
    markNonSilentFailure: () => {
      state.failedNonSilent += 1;
    },
    snapshot: () => ({ ...state }),
  };
}
