/**
 * @fileoverview 因果传染推理异常评估引擎（四态分级 + 跨步传染窗口，纯算法零外部依赖）。
 *
 * 核心设计原则：
 * 1. 四态清晰定级（废除伪精确的混合 0-100 扣分）：
 *    统一输出 `healthy`（正常）、`notice`（留意）、`warn`（预警）、`critical`（失控）四态及证据链。
 * 2. 剥离「良性计费/链路波动」与「有损认知劣化」：
 *    - 缓存命中率 >= 50% 的正常前缀伸缩（如临时 `<SYSTEM_MESSAGE>` 消退）与 >= 180s 自然 TTL 过期一律视为正常；
 *    - 思考深度正常且执行无误的短时冷缓存或网关单次自动恢复重试，仅写入列级轻量说明（`isColdCacheBilling` / `infraNote`），
 *      不污染 `异常(N)` 筛选，绝不误导回滚代码。
 * 3. `#1807` 型「链路冲击挤压思考 + 4 步下游传染追踪（Causal Contagion State Machine）」：
 *    - 当首字严重卡顿（>= max(20s, 2.4x 会话同模型中位数)）、上游重试或热缓存骤冷发生时，若同时伴随思考占比与有效思考速率断崖缩水：
 *      * 若前一步存在未消解报错或当步直接修改代码，当场定级 `warn`（`卡顿缩水`）；
 *      * 若当步仅为普通只读探测，先标 `notice`（`浅思`）并开启 4 步传染观察窗；
 *      * 一旦观察窗内出现脚本/编辑/测试报错、连续零思考仓促修补或同区返工，立即升格为 `warn/critical`（`劣化传染`）并溯源回源头步骤。
 * 4. 四大内生失控闭环检测器：
 *    - `command_fault_loop`（执行受阻）：构建/测试连续失败 >= 3 次未翻绿、脚本连续崩溃、或编辑失败后不重读盲改；
 *    - `code_thrashing`（反复返工）：单轮同代码区 `A -> B -> A` 震荡回退或连续 >= 3 次推翻重写未验证收敛；
 *    - `exploration_stall`（空转停滞）：单轮连续 >= 12 步纯只读检索且无方案产出与修改动作；
 *    - `context_rot` / `infinite_loop`（上下文过载 / 复读死循环）：高水位下真实静态同区间重读伴随失误，或相同工具参数/文本死循环。
 */

const IH_CACHE_TTL_MAX_SEC = 180;
const IH_COLD_DROP_PREV_MIN = 32000;
const IH_CONTAGION_WINDOW_STEPS = 4;

const IH_STATE_LABELS = {
  healthy: '正常',
  notice: '留意',
  warn: '预警',
  critical: '失控',
};

const IH_LEVEL_RANK = {
  healthy: 0,
  notice: 1,
  warn: 2,
  critical: 3,
};

const IH_COMPAT_ORDINAL_SCORE = {
  healthy: 100,
  notice: 80,
  warn: 50,
  critical: 20,
};

export function formatHealthStateLabel(level) {
  return IH_STATE_LABELS[level] || '正常';
}

function ihMaxLevel(a, b) {
  return (IH_LEVEL_RANK[b] || 0) > (IH_LEVEL_RANK[a] || 0) ? b : a;
}

function ihMedian(nums) {
  if (!Array.isArray(nums) || nums.length === 0) return null;
  const sorted = nums.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function ihFormatCompactTok(n) {
  const num = Number(n || 0);
  if (num >= 1000) return `${(num / 1000).toFixed(1)}k`;
  return String(Math.round(num));
}

function ihCleanUpstreamErrorText(raw) {
  const txt = typeof raw === 'string' ? raw.trim() : '';
  if (!txt || txt === '[object Object]') return '';
  return txt;
}

function ihIsExecWorkerStep(st, hasPlannerModel) {
  if (st?.healthSignals?.inExecutionPhase) return true;
  if (!hasPlannerModel) return false;
  const sig = `${st?.modelDisplayName || ''} ${st?.responseModel || ''} ${st?.modelLabel || ''}`;
  return /Orchestrator Worker|gemini-flash-worker-agy|\bhydrogen\b/i.test(sig);
}

function ihIsWorkerMarkerText(st) {
  const sig = `${st?.modelDisplayName || ''} ${st?.responseModel || ''} ${st?.modelLabel || ''}`;
  return /Orchestrator Worker|gemini-flash-worker-agy|\bhydrogen\b/i.test(sig);
}

function ihSameCachePoolModel(a, b) {
  if (!a || !b || a.modelKey !== b.modelKey) return false;
  if (a.responseModel && b.responseModel && a.responseModel !== b.responseModel) {
    return false;
  }
  if (a.modelShort && b.modelShort && a.modelShort !== b.modelShort) {
    return false;
  }
  return true;
}

function ihModelBucketKey(st) {
  const mk = st?.modelKey || 'unknown';
  const sub = String(st?.responseModel || st?.modelShort || '')
    .replace(/·压缩|\[自动压缩\]/g, '')
    .trim()
    .toLowerCase();
  return sub ? `${mk}::${sub}` : mk;
}

function ihBuildModelBaselines(chronoSteps, hasPlannerModel) {
  const byModel = new Map();
  for (const st of chronoSteps) {
    if (!st || st.isCompactionStep) continue;
    if (ihIsExecWorkerStep(st, hasPlannerModel)) continue;
    const key = ihModelBucketKey(st);
    let entry = byModel.get(key);
    if (!entry) {
      entry = {
        substantiveCount: 0,
        thinkingObsCount: 0,
        cleanThinkShares: [],
        allThinkShares: [],
        cleanThinkTokens: [],
        allThinkTokens: [],
        cleanTtfts: [],
        allTtfts: [],
      };
      byModel.set(key, entry);
    }
    const hs = st.healthSignals || {};
    const outTok = Number(st.outputTokens || 0);
    const thinkTok = Number(st.thinkingTokens || 0);
    const ttftVal = Number(st.ttftSec ?? st.nativeTtftSec);
    const thinkWin = Math.max(
      Number(st.thinkingDurationSec || 0),
      Number.isFinite(ttftVal) ? ttftVal : 0,
      0.1
    );
    const effThinkRate = thinkTok / thinkWin;
    const isUncontaminated =
      (hs.upstreamErrorCount || 0) === 0 &&
      (hs.retryCount || 0) === 0 &&
      (!Number.isFinite(ttftVal) || ttftVal < 22) &&
      effThinkRate >= 10;

    if (outTok >= 120 || (st.totalDurationSec || 0) >= 1.5) {
      entry.substantiveCount += 1;
    }
    if (
      thinkTok >= 80 ||
      hs.hasThinkingText === true ||
      ((st.thinkingDurationSec || 0) >= 1.5 && thinkTok > 0)
    ) {
      entry.thinkingObsCount += 1;
    }
    if (outTok >= 300 && thinkTok > 0) {
      const share = thinkTok / outTok;
      entry.allThinkShares.push(share);
      entry.allThinkTokens.push(thinkTok);
      if (isUncontaminated) {
        entry.cleanThinkShares.push(share);
        entry.cleanThinkTokens.push(thinkTok);
      }
    }
    if (Number.isFinite(ttftVal) && ttftVal > 0 && ttftVal < 120) {
      entry.allTtfts.push(ttftVal);
      if (ttftVal < 22 && (hs.upstreamErrorCount || 0) === 0) {
        entry.cleanTtfts.push(ttftVal);
      }
    }
  }

  const resolved = new Map();
  for (const [key, raw] of byModel.entries()) {
    const sharePool =
      raw.cleanThinkShares.length >= 2 ? raw.cleanThinkShares : raw.allThinkShares;
    const tokPool =
      raw.cleanThinkTokens.length >= 2 ? raw.cleanThinkTokens : raw.allThinkTokens;
    const ttftPool = raw.cleanTtfts.length >= 2 ? raw.cleanTtfts : raw.allTtfts;
    resolved.set(key, {
      demonstratesThinking:
        raw.thinkingObsCount >= 2
          ? raw.thinkingObsCount / Math.max(1, raw.substantiveCount) >= 0.35
          : raw.thinkingObsCount >= 1 && raw.substantiveCount <= 2,
      medianThinkShare: ihMedian(sharePool) ?? 0,
      medianThinkTokens: ihMedian(tokPool) ?? 0,
      medianTtft: ttftPool.length >= 2 ? ihMedian(ttftPool) : 9.0,
    });
  }
  return resolved;
}

function ihBuildTurnDiagnosis({
  turnIndex,
  turnSteps,
  stepFindingsMap,
  contagionEvents,
  agentId,
  agentBadge,
}) {
  let totalEditFaults = 0;
  let totalBlindEditRetries = 0;
  let totalToolFaults = 0;
  let totalVerifyFails = 0;
  let maxVerifyFailStreak = 0;
  let totalAmnesiaReads = 0;
  let maxSameRegionRework = 0;
  let maxOscillationRevert = 0;
  let maxReadOnlyStreak = 0;
  let maxIdenticalToolStreak = 0;
  let hasHighRepeat = false;
  let workerFaultSteps = 0;
  let workerFaultTotal = 0;
  let unshockedZeroThinkFaultCount = 0;
  let repeatedGatewayFaultSteps = 0;
  let maxCtxInTurn = 0;
  let maxBudgetInTurn = 512000;
  let userRejectedTurn = false;
  let confirmedRollback = false;

  let lastProblemOrd = -1;
  let trailingSubstantiveClean = 0;
  let tailVerifiedPass = false;

  for (let i = 0; i < turnSteps.length; i++) {
    const st = turnSteps[i];
    const hs = st.healthSignals || {};
    const f = stepFindingsMap.get(st) || {};

    const ctxVal = Number(
      st.contextTokens ||
        st.estimatedContextTokens ||
        (st.inputTokens || 0) + (st.cacheReadTokens || 0) ||
        0
    );
    if (ctxVal > maxCtxInTurn) maxCtxInTurn = ctxVal;
    const bVal = Number(st.maxContextBudgetTokens || 0);
    if (bVal > 0) maxBudgetInTurn = bVal;

    if (hs.userRejectedTurn) userRejectedTurn = true;
    if (hs.confirmedRollback) confirmedRollback = true;

    totalEditFaults += f.editFaultCount || 0;
    totalBlindEditRetries += f.blindEditRetryCount || 0;
    totalToolFaults += f.toolFaultCount || 0;
    totalVerifyFails += f.verifyFailCount || 0;
    if ((f.verifyFailStreak || 0) > maxVerifyFailStreak) {
      maxVerifyFailStreak = f.verifyFailStreak;
    }
    totalAmnesiaReads += f.amnesiaReadCount || 0;
    if ((f.sameRegionReworkCount || 0) > maxSameRegionRework) {
      maxSameRegionRework = f.sameRegionReworkCount;
    }
    if ((f.oscillationRevertCount || 0) > maxOscillationRevert) {
      maxOscillationRevert = f.oscillationRevertCount;
    }
    if ((f.readOnlyStreak || 0) > maxReadOnlyStreak) {
      maxReadOnlyStreak = f.readOnlyStreak;
    }
    if ((f.identicalToolStreak || 0) > maxIdenticalToolStreak) {
      maxIdenticalToolStreak = f.identicalToolStreak;
    }
    if (f.highRepeat) hasHighRepeat = true;
    if (f.workerFault) {
      workerFaultSteps += 1;
      workerFaultTotal += (f.editFaultCount || 0) + (f.toolFaultCount || 0);
    }
    if (f.unshockedZeroThink && (f.editFaultCount > 0 || f.toolFaultCount > 0 || f.thrashingEdits)) {
      unshockedZeroThinkFaultCount += 1;
    }
    if (f.repeatedUpstreamFault) {
      repeatedGatewayFaultSteps += 1;
    }

    const isProblemStep =
      st.stepHealthLevel === 'warn' ||
      st.stepHealthLevel === 'critical' ||
      f.editFaultCount > 0 ||
      f.toolFaultCount > 0 ||
      f.verifyFailCount > 0;
    if (isProblemStep) {
      lastProblemOrd = i;
      trailingSubstantiveClean = 0;
      tailVerifiedPass = false;
    } else {
      if ((st.outputTokens || 0) >= 180 || hs.cleanVerifyPass) {
        trailingSubstantiveClean += 1;
      }
      if (hs.cleanVerifyPass) {
        tailVerifiedPass = true;
      }
    }
  }

  const tailStep = turnSteps[turnSteps.length - 1] || null;
  const tailReadOnlyStreak = tailStep ? stepFindingsMap.get(tailStep)?.readOnlyStreak || 0 : 0;
  const tailVerifyStreak = tailStep ? stepFindingsMap.get(tailStep)?.verifyFailStreak || 0 : 0;

  const isHighContext =
    maxCtxInTurn >= Math.min(200000, Math.max(150000, Math.round(maxBudgetInTurn * 0.55)));
  const hasThrashing =
    maxOscillationRevert >= 2 || (maxSameRegionRework >= 3 && !tailVerifiedPass);
  const hasInfiniteLoop = hasHighRepeat || maxIdenticalToolStreak >= 3;
  const hasContextRot =
    isHighContext &&
    (totalAmnesiaReads >= 2 ||
      (totalAmnesiaReads >= 1 &&
        (totalEditFaults >= 1 || totalToolFaults >= 1 || maxSameRegionRework >= 2)));
  const activeContagions = contagionEvents.filter(
    (ce) => ce.escalated || ce.infected.length > 0
  );
  const noticeContagions = contagionEvents.filter(
    (ce) => !ce.escalated && ce.infected.length === 0
  );
  const hasWorkerHandoffIssue =
    workerFaultSteps >= 1 &&
    (workerFaultTotal >= 2 ||
      (!tailVerifiedPass && trailingSubstantiveClean === 0) ||
      confirmedRollback ||
      userRejectedTurn);
  const hasFaultLoop =
    tailVerifyStreak >= 3 ||
    maxVerifyFailStreak >= 3 ||
    totalEditFaults >= 2 ||
    totalBlindEditRetries >= 1 ||
    totalToolFaults >= 2 ||
    unshockedZeroThinkFaultCount >= 1 ||
    ((totalEditFaults >= 1 || totalToolFaults >= 1) && (userRejectedTurn || confirmedRollback));
  const hasExplorationStall = tailReadOnlyStreak >= 12;
  const hasGatewayInstability = repeatedGatewayFaultSteps >= 2;

  let category = '';
  let level = 'healthy';
  let anchorStepIndex = null;

  if (hasInfiniteLoop) {
    category = 'infinite_loop';
    level = 'critical';
  } else if (hasContextRot) {
    category = 'context_rot';
    level = totalAmnesiaReads >= 3 || totalEditFaults >= 2 ? 'critical' : 'warn';
  } else if (activeContagions.length > 0) {
    category = 'degraded_contagion';
    const worst = activeContagions[activeContagions.length - 1];
    anchorStepIndex = worst.sourceStep.stepIndex;
    level =
      worst.infected.length >= 2 && !tailVerifiedPass && trailingSubstantiveClean < 2
        ? 'critical'
        : 'warn';
  } else if (hasWorkerHandoffIssue) {
    category = 'worker_handoff';
    level = workerFaultTotal >= 3 ? 'critical' : 'warn';
  } else if (hasFaultLoop) {
    category = 'tool_fault_loop';
    level =
      tailVerifyStreak >= 4 || totalEditFaults + totalToolFaults >= 4 ? 'critical' : 'warn';
  } else if (hasThrashing) {
    category = 'code_thrashing';
    level = maxOscillationRevert >= 2 && maxSameRegionRework >= 4 ? 'critical' : 'warn';
  } else if (hasExplorationStall) {
    category = 'exploration_stall';
    level = tailReadOnlyStreak >= 18 ? 'critical' : 'warn';
  } else if (hasGatewayInstability) {
    category = 'gateway_instability';
    level = 'warn';
  } else if (
    noticeContagions.length > 0 ||
    totalEditFaults > 0 ||
    totalToolFaults > 0 ||
    totalAmnesiaReads > 0
  ) {
    level = 'notice';
  }

  if (confirmedRollback && level !== 'healthy') {
    level = 'critical';
    if (!category) category = 'tool_fault_loop';
  } else if (userRejectedTurn && (level === 'notice' || unshockedZeroThinkFaultCount > 0)) {
    level = 'warn';
    if (!category) category = 'tool_fault_loop';
  }

  // 构建因果证据链（按时间与因果顺序呈现，优先源头 -> 传导步骤）
  const reasons = [];
  if (category === 'degraded_contagion' && activeContagions.length > 0) {
    const primaryCe = activeContagions[activeContagions.length - 1];
    reasons.push(`#${primaryCe.sourceStep.stepIndex} ${primaryCe.sourceProof}`);
    for (const inf of primaryCe.infected.slice(0, 2)) {
      reasons.push(`#${inf.stepIndex} 传导后遗症：${inf.symptom}`);
    }
  } else {
    const weightedReasons = [];
    for (const st of turnSteps) {
      const f = stepFindingsMap.get(st);
      if (f?.primaryReason) {
        weightedReasons.push({
          stepIndex: st.stepIndex,
          text: `#${st.stepIndex} ${f.primaryReason}`,
          rank: IH_LEVEL_RANK[st.stepHealthLevel] || 0,
        });
      }
    }
    weightedReasons.sort((a, b) => b.rank - a.rank || a.stepIndex - b.stepIndex);
    for (const item of weightedReasons.slice(0, 3)) {
      reasons.push(item.text);
    }
  }

  if (confirmedRollback && reasons.length < 3) {
    reasons.push('后续轮次已由用户打断并执行 Git 回滚');
  } else if (userRejectedTurn && reasons.length < 3) {
    reasons.push('后续轮次用户显式否定本轮结果并要求重做');
  }

  if (anchorStepIndex === null) {
    let bestRank = -1;
    for (const st of turnSteps) {
      const r = IH_LEVEL_RANK[st.stepHealthLevel] || 0;
      if (r > bestRank && r >= 1) {
        bestRank = r;
        anchorStepIndex = st.stepIndex;
      }
    }
    if (anchorStepIndex === null) {
      anchorStepIndex = turnSteps[0]?.stepIndex ?? null;
    }
  }

  const stateLabel = formatHealthStateLabel(level);
  const compatScore = IH_COMPAT_ORDINAL_SCORE[level] ?? 100;

  if (level !== 'warn' && level !== 'critical') {
    return {
      turnIndex,
      score: compatScore,
      level,
      stateLabel,
      category: '',
      badge: '',
      title: '',
      summary: '',
      anchorStepIndex,
      reasons,
      isResolved: true,
      agentId,
      agentBadge,
      primaryAction: null,
      secondaryAction: null,
    };
  }

  // 判断本轮尾段是否已经彻底自愈（用于决定实时顶栏 activeAlert 是否自动消退，历史步骤徽章始终保留）
  const isPersistentCategory =
    category === 'context_rot' ||
    category === 'infinite_loop' ||
    category === 'exploration_stall';
  const isResolved =
    !isPersistentCategory &&
    !confirmedRollback &&
    !userRejectedTurn &&
    lastProblemOrd >= 0 &&
    ((tailVerifiedPass && trailingSubstantiveClean >= 2) || trailingSubstantiveClean >= 4);

  const stepRef = anchorStepIndex !== null ? `#${anchorStepIndex}` : '问题步';
  let badge = '执行受阻';
  let title = '本轮编辑或命令执行连续受阻';
  let summary = '检测到连续工具报错或盲目重试未收敛，建议先停下核对真实文件内容与报错根因。';
  let primaryAction = {
    kind: 'copy',
    label: `复制 ${stepRef} 收敛止损指令`,
    copyText: `先停下盲目试错（${stepRef} 附近连续执行受阻）。请先读取目标文件的准确上下文并核清报错根因，给出最小修复方案后再动手。`,
    toast: '已复制止损指令',
  };
  let secondaryAction = {
    kind: 'jump_step',
    label: `定位 ${stepRef}`,
    stepIndex: anchorStepIndex,
    agentId,
  };

  if (category === 'degraded_contagion') {
    const ce = activeContagions[activeContagions.length - 1];
    const hasDownstream = ce && ce.infected.length > 0;
    badge = hasDownstream ? '劣化传染' : '卡顿缩水';
    title = hasDownstream
      ? `源头 ${stepRef} 卡顿缩水并传导引发后续失误`
      : `${stepRef} 链路冲击导致思考深度断崖缩水`;
    summary = hasDownstream
      ? `${stepRef} 经历首字长卡顿或链路重试后思考严重缩水，浅思考惯性已传导引发后续步骤连续报错或仓促修补；建议打断惯性重新完整审视。`
      : `${stepRef} 经历长卡顿或重试恢复后思考投入相比本会话基线大幅缩水，直接修改代码易埋下遗漏，建议核验边界条件。`;
    primaryAction = {
      kind: 'copy',
      label: `复制 ${stepRef} 溯源重审指令`,
      copyText: `先暂停顺着当前惯性修补：从 ${stepRef} 步起思考深度明显缩水并引发后续偏差。请重新完整核对相关模块接口、前提假设与修改边界，确认无误后再继续。`,
      toast: '已复制重审指令',
    };
  } else if (category === 'context_rot') {
    badge = '上下文过载';
    title = `高水位上下文注意力退化（${ihFormatCompactTok(maxCtxInTurn)}）`;
    summary =
      '高上下文水位下出现真实静态同区间重复重读与定位脱靶，继续堆叠历史易越改越乱，建议立即执行 /compact 压缩或交接新开会话。';
    primaryAction = {
      kind: 'copy',
      label: '复制 /compact 指令',
      copyText: '/compact',
      toast: '已复制 /compact',
    };
    secondaryAction = {
      kind: 'copy',
      label: '复制交接摘要指令',
      copyText:
        '先暂停修改。请将当前已改文件、未完成事项、关键约束与验证结论整理为结构化交接摘要，我将压缩或新开会话继续。',
      toast: '已复制交接指令',
    };
  } else if (category === 'infinite_loop') {
    badge = '复读死循环';
    title =
      maxIdenticalToolStreak >= 3
        ? `连续 ${maxIdenticalToolStreak} 次重复调用完全相同的工具参数`
        : '模型输出陷入高比例重复坍缩';
    summary = '模型已陷入局部死循环，继续等待只会消耗配额，建议立即打断并换用明确约束指令。';
    primaryAction = {
      kind: 'copy',
      label: '复制破除循环指令',
      copyText: `立即停止重复执行相同操作（${stepRef} 已陷入重复循环）。请直接汇报当前卡点与缺失信息，不要再重复调用同一工具。`,
      toast: '已复制破除循环指令',
    };
  } else if (category === 'code_thrashing') {
    badge = '反复返工';
    title = '同一代码区域来回推翻或反复重写';
    summary = '单轮内针对同一代码片段发生回退震荡或连续多次覆写仍未验证收敛，建议先厘清约束再一次性改对。';
    primaryAction = {
      kind: 'copy',
      label: `复制 ${stepRef} 收敛指令`,
      copyText: `先暂停反复改写同一处代码（${stepRef}）。请先列出该处所有边界条件与冲突原因，确认唯一正确方案后再修改并跑测试验证。`,
      toast: '已复制收敛指令',
    };
  } else if (category === 'exploration_stall') {
    badge = '空转停滞';
    title = `连续 ${tailReadOnlyStreak || maxReadOnlyStreak} 步纯只读检索仍未收敛`;
    summary = '单轮连续大量碎步读文件或搜代码却迟迟未输出结论或进入修改验证，建议要求模型先汇总现状并给出行动方案。';
    primaryAction = {
      kind: 'copy',
      label: '复制收敛催办指令',
      copyText:
        '请先停止继续发散检索文件，基于目前已读到的证据直接汇总根因判断与具体修改计划。',
      toast: '已复制催办指令',
    };
  } else if (category === 'worker_handoff') {
    badge = '执行层切换';
    title = '轻量执行层接管后连续工具失误';
    summary = 'Plan->Execution 轻量执行模型在落地修改时出现连续对齐或语法失误，建议切回主规划模型重审后再执行。';
    primaryAction = {
      kind: 'copy',
      label: '复制旗舰重审指令',
      copyText: `停止当前轻量执行尝试。请重新核对 ${stepRef} 之前的目标文件真实行号与语法上下文，修正后再执行。`,
      toast: '已复制重审指令',
    };
  } else if (category === 'tool_fault_loop' && maxVerifyFailStreak >= 3) {
    badge = '测试连败';
    title = `构建或测试连续 ${maxVerifyFailStreak} 次失败未翻绿`;
    summary = '模型在「修改 -> 跑挂 -> 再盲改」循环中未能收敛，建议要求其先最小化复现并核清断言失败根因。';
  } else if (category === 'gateway_instability') {
    badge = '网关抖动';
    title = '本轮上游网关连续超时或中断重试';
    summary = '服务端连接持续不稳定，若后续步骤伴随卡顿或中断建议稍候再试或切换模型。';
    primaryAction = {
      kind: 'jump_step',
      label: `定位 ${stepRef}`,
      stepIndex: anchorStepIndex,
      agentId,
    };
    secondaryAction = null;
  }

  return {
    turnIndex,
    score: compatScore,
    level,
    stateLabel,
    category,
    badge,
    title,
    summary,
    anchorStepIndex,
    reasons,
    isResolved,
    agentId,
    agentBadge,
    primaryAction,
    secondaryAction,
    alertKey: `${agentId || 'main'}:T${turnIndex}:${category}:${level}:${anchorStepIndex ?? 'none'}:${reasons.length}`,
  };
}

/**
 * 对单个代理（主代理或子代理）的标准化步骤数组执行因果推理健康评估。
 */
export function evaluateAgentInferenceHealth(steps = [], options = {}) {
  const agentId = options.agentId || 'main';
  const agentBadge = options.agentBadge || '主';

  if (!Array.isArray(steps) || steps.length === 0) {
    return {
      sessionScore: 100,
      sessionLevel: 'healthy',
      sessionStateLabel: '正常',
      anomalyStepCount: 0,
      anomalyTurnCount: 0,
      activeAlert: null,
      turnDiagnoses: [],
    };
  }

  const hasPlannerModel = steps.some(
    (s) => s && !s.isCompactionStep && !s.healthSignals?.inExecutionPhase && !ihIsWorkerMarkerText(s)
  );
  const baselines = ihBuildModelBaselines(steps, hasPlannerModel);

  const stepFindingsMap = new Map();
  const contagionByTurn = new Map();

  let prevNonCompact = null;
  let prevIsWorker = false;
  let activeTurnIdx = null;
  let recentTurnPlanCarryover = 0;
  let prevUnresolvedFault = false;
  let activeContagion = null;

  for (let i = 0; i < steps.length; i++) {
    const st = steps[i];
    if (!st || typeof st !== 'object') continue;
    const hs = st.healthSignals || {};

    st.isColdCacheBilling = false;
    st.cacheNote = '';
    st.infraNote = '';
    st.isCacheAnomaly = false;
    st.cacheZeroReason = '';

    if (st.isCompactionStep) {
      prevNonCompact = null;
      prevIsWorker = false;
      recentTurnPlanCarryover = 0;
      prevUnresolvedFault = false;
      activeContagion = null;
      st.stepHealthLevel = 'healthy';
      st.stepHealthBadge = '';
      st.stepHealthDetail = '';
      st.cacheZeroReason = st.cacheReadTokens === 0 ? 'compaction' : '';
      continue;
    }

    if (st.turnIndex !== activeTurnIdx) {
      activeTurnIdx = st.turnIndex;
      recentTurnPlanCarryover = 0;
      prevUnresolvedFault = false;
      activeContagion = null;
    }

    const isWorker = ihIsExecWorkerStep(st, hasPlannerModel);
    const baseline = baselines.get(ihModelBucketKey(st)) || {
      demonstratesThinking: false,
      medianThinkShare: 0,
      medianThinkTokens: 0,
      medianTtft: 9.0,
    };

    // 1. 识别链路层与缓存层原始事件（区分良性波动 vs 上游冲击）
    const cleanErrText = ihCleanUpstreamErrorText(hs.upstreamErrorText);
    const upstreamErrCount = Number(hs.upstreamErrorCount || 0);
    const retryCount = Number(hs.retryCount || 0);
    const hasUpstreamRetry = upstreamErrCount > 0 || retryCount > 0;
    const repeatedUpstreamFault =
      upstreamErrCount >= 2 || retryCount >= 2 || Boolean(hs.wasCanceled && hasUpstreamRetry);

    let coldCacheDrop = null;
    const totalPromptTok = (st.inputTokens || 0) + (st.cacheReadTokens || 0);
    const cacheHitRatio = totalPromptTok > 0 ? (st.cacheReadTokens || 0) / totalPromptTok : 1;
    const sameCachePool = prevNonCompact && ihSameCachePoolModel(st, prevNonCompact);

    if (
      sameCachePool &&
      !hs.justSwitchedExecPhase &&
      isWorker === prevIsWorker &&
      prevNonCompact.createdAtMs > 0 &&
      st.createdAtMs >= prevNonCompact.createdAtMs
    ) {
      const prevFinishMs =
        prevNonCompact.createdAtMs +
        Math.max(0, Number(prevNonCompact.totalDurationSec || 0) * 1000);
      const idleSec =
        st.createdAtMs >= prevFinishMs
          ? Math.max(0, (st.createdAtMs - prevFinishMs) / 1000)
          : Math.max(0, (st.createdAtMs - prevNonCompact.createdAtMs) / 1000);

      if (idleSec < IH_CACHE_TTL_MAX_SEC) {
        if (
          prevNonCompact.cacheReadTokens >= IH_COLD_DROP_PREV_MIN &&
          cacheHitRatio < 0.15 &&
          (st.inputTokens || 0) >= Math.max(16000, prevNonCompact.cacheReadTokens * 0.5)
        ) {
          coldCacheDrop = {
            dtSec: Math.round(idleSec),
            lostTokens: Math.max(0, prevNonCompact.cacheReadTokens - (st.cacheReadTokens || 0)),
            isZero: (st.cacheReadTokens || 0) === 0,
          };
        }
      } else if (
        (st.cacheReadTokens || 0) === 0 &&
        prevNonCompact.cacheReadTokens >= 12000
      ) {
        st.cacheZeroReason = 'ttl_expired';
      }
    } else if ((st.cacheReadTokens || 0) === 0) {
      st.cacheZeroReason = hs.justSwitchedExecPhase
        ? 'phase_switch'
        : prevNonCompact && !sameCachePool
          ? 'model_switch'
          : 'cold_start';
    }
    if (!coldCacheDrop && (st.cacheReadTokens || 0) === 0 && !st.cacheZeroReason) {
      st.cacheZeroReason = prevNonCompact ? 'low_prefix' : 'cold_start';
    }

    const ttftVal = Number(st.ttftSec ?? st.nativeTtftSec);
    const isTtftStall =
      !isWorker &&
      baseline.demonstratesThinking &&
      Number.isFinite(ttftVal) &&
      ttftVal >= Math.max(20, (baseline.medianTtft || 9) * 2.4);

    const hasUpstreamShock = Boolean(isTtftStall || hasUpstreamRetry || coldCacheDrop);
    if (hasUpstreamShock || !sameCachePool) {
      recentTurnPlanCarryover = 0;
    }

    // 2. 提取当步工具与执行行为特征
    const editFaultCount = Number(hs.editFaultCount || 0);
    const blindEditRetryCount = Number(hs.blindEditRetryCount || 0);
    const toolFaultCount = Number(hs.toolFaultCount || 0);
    const toolFaultLabel = hs.toolFaultLabel || '';
    const verifyFailCount = Number(hs.verifyFailCount || 0);
    const verifyFailStreak = Number(hs.verifyFailStreak || 0);
    const amnesiaReadCount = Number(hs.amnesiaReadCount || 0);
    const sameRegionReworkCount = Number(hs.sameRegionReworkCount || 0);
    const oscillationRevertCount = Number(hs.oscillationRevertCount || 0);
    const readOnlyStreak = Number(hs.readOnlyStreak || 0);
    const identicalToolStreak = Number(hs.identicalToolStreak || 0);
    const thrashingEdits = sameRegionReworkCount >= 3 || oscillationRevertCount >= 2;
    const highRepeat = Number(hs.outputRepeatRatio || 0) >= 0.58;
    const workerFault = isWorker && (editFaultCount > 0 || toolFaultCount > 0);
    const hasDirectExecFault =
      editFaultCount > 0 ||
      blindEditRetryCount > 0 ||
      toolFaultCount > 0 ||
      thrashingEdits ||
      highRepeat ||
      identicalToolStreak >= 3;

    // 3. 评估思考深度与 `#1807` 型「链路冲击挤压思考」
    const thinkTok = Number(st.thinkingTokens || 0);
    const outTok = Number(st.outputTokens || 0);
    const thinkTextLen = Number(hs.thinkingTextLen || 0);
    const postTtftThinkSec =
      Number.isFinite(st.thinkingDurationSec) && Number.isFinite(ttftVal)
        ? Math.max(0, st.thinkingDurationSec - ttftVal)
        : 0;
    const hasDeepThought =
      thinkTok >= 300 ||
      thinkTextLen >= 900 ||
      (postTtftThinkSec >= 6 && thinkTok >= 180);

    const inheritedTurnPlan =
      !hasUpstreamShock &&
      !prevUnresolvedFault &&
      !activeContagion &&
      recentTurnPlanCarryover > 0 &&
      !hasDirectExecFault &&
      Boolean(st.hasToolCalls || hs.isCodeEditStep || hs.isMutationStep);

    const thinkWindowSec = Math.max(
      Number(st.thinkingDurationSec || 0),
      Number.isFinite(ttftVal) ? ttftVal : 0,
      0.1
    );
    const effThinkTps = thinkTok / thinkWindowSec;
    const thinkShare = outTok > 0 ? thinkTok / outTok : 0;

    let shockSqueeze = false;
    let shockSqueezeProof = '';
    let unshockedZeroThink = false;

    if (!isWorker && baseline.demonstratesThinking && !hasDeepThought && !inheritedTurnPlan) {
      const isSubstantiveStep =
        outTok >= 450 || ((hs.isCodeEditStep || hs.isMutationStep) && outTok >= 350);
      const isStalledShortToolStep =
        isTtftStall &&
        ttftVal >= 30 &&
        !coldCacheDrop &&
        Boolean(st.hasToolCalls) &&
        thinkTok < 150 &&
        effThinkTps < 3.5;
      const collapsedRelativeToBaseline =
        (thinkTok < 50 && !hs.hasThinkingText) ||
        (effThinkTps < 12 &&
          ((baseline.medianThinkShare >= 0.22 && thinkShare < baseline.medianThinkShare * 0.42) ||
            (outTok >= 750 &&
              baseline.medianThinkTokens >= 250 &&
              thinkTok < Math.min(220, baseline.medianThinkTokens * 0.32))));

      if (
        hasUpstreamShock &&
        ((isSubstantiveStep && collapsedRelativeToBaseline) || isStalledShortToolStep)
      ) {
        shockSqueeze = true;
        if (isTtftStall) {
          shockSqueezeProof = `首字卡顿 ${ttftVal.toFixed(1)}s 挤压思考（仅 ${thinkTok} tok，有效思考 ${effThinkTps.toFixed(1)} tok/s）`;
        } else if (hasUpstreamRetry) {
          shockSqueezeProof = `上游重试${cleanErrText ? ` (${cleanErrText})` : ''}后思考坍缩（仅 ${thinkTok} tok，输出 +${outTok} tok）`;
        } else if (coldCacheDrop) {
          shockSqueezeProof = `${coldCacheDrop.dtSec}s 内热缓存骤冷后思考缩水（仅 ${thinkTok} tok）`;
        }
      } else if (
        !hasUpstreamShock &&
        thinkTok < 55 &&
        !hs.hasThinkingText &&
        ((hs.isCodeEditStep && outTok >= 650) ||
          outTok >= 1500 ||
          ((prevUnresolvedFault || Boolean(activeContagion)) && outTok >= 450))
      ) {
        unshockedZeroThink = true;
      }
    }

    // 良性冷缓存、良性单次重试与单纯上游长卡顿：仅写入列级轻量提示，绝不误判为推理劣化
    if (coldCacheDrop && !shockSqueeze) {
      st.isColdCacheBilling = true;
      st.cacheNote = `${coldCacheDrop.dtSec}s 内触发冷缓存重算（丢失 ${ihFormatCompactTok(coldCacheDrop.lostTokens)} tok，仅影响首字与计费，推理质量正常）`;
    }
    if (hasUpstreamRetry && !repeatedUpstreamFault && !shockSqueeze && !hasDirectExecFault) {
      st.infraNote = cleanErrText
        ? `上游单次重试已自动恢复 (${cleanErrText})`
        : '上游单次瞬时重试已自动恢复';
    } else if (isTtftStall && !shockSqueeze && !coldCacheDrop) {
      st.infraNote = `首字响应长卡顿 ${ttftVal.toFixed(1)}s（上游连接阻塞或静默重连，思考未受损）`;
    }

    // 4. 先处理前序已开启的 4 步传染观察窗（若当前步命中后遗症则溯源追责）
    let infectedFromStepIdx = null;
    if (activeContagion && activeContagion.remaining > 0) {
      activeContagion.remaining -= 1;
      let contagionSymptom = '';
      if (editFaultCount > 0) {
        contagionSymptom =
          blindEditRetryCount > 0 ? '未重读盲改导致编辑失败' : `编辑原文匹配失败 ${editFaultCount} 次`;
      } else if (toolFaultCount > 0) {
        contagionSymptom = `脚本执行崩溃${toolFaultLabel ? ` (${toolFaultLabel})` : ''}`;
      } else if (verifyFailCount > 0) {
        contagionSymptom = '测试/构建验证失败';
      } else if (sameRegionReworkCount >= 2 || oscillationRevertCount >= 1) {
        contagionSymptom = '同区域代码反复推翻返工';
      } else if (amnesiaReadCount > 0) {
        contagionSymptom = '重复读取未改文件';
      } else if (unshockedZeroThink || (thinkTok < 60 && !hs.hasThinkingText && outTok >= 400)) {
        contagionSymptom = `可见思考归零仓促修补 (+${outTok} tok)`;
      }

      if (contagionSymptom) {
        infectedFromStepIdx = activeContagion.sourceStep.stepIndex;
        activeContagion.infected.push({
          step: st,
          stepIndex: st.stepIndex,
          symptom: contagionSymptom,
        });
        activeContagion.escalated = true;
        activeContagion.remaining = Math.max(activeContagion.remaining, 2);

        // 反向升级源头步骤（如 #1807 从 notice「浅思」直接升格为 warn「卡顿缩水」并补齐传导链）
        const srcSt = activeContagion.sourceStep;
        const infRefs = activeContagion.infected.map((x) => `#${x.stepIndex}`).join(', ');
        srcSt.stepHealthLevel =
          activeContagion.infected.length >= 3 ? 'critical' : ihMaxLevel(srcSt.stepHealthLevel, 'warn');
        srcSt.stepHealthBadge = '卡顿缩水';
        srcSt.stepHealthDetail = `${activeContagion.sourceProof} -> 传导至 ${infRefs}`;
      } else if (hasDeepThought && !hasDirectExecFault && verifyFailCount === 0) {
        // 思考深度恢复正常基线且零报错（如 #1817），关闭传染观察窗
        activeContagion = null;
      } else if (activeContagion.remaining <= 0) {
        activeContagion = null;
      }
    }

    // 5. 若当前步自身就是新的 `#1807` 型冲击缩水源头，执行分级定级并开启 4 步传染窗
    let stepLevel = 'healthy';
    let stepBadge = '';
    const detailParts = [];

    if (shockSqueeze) {
      const immediateEscalate =
        prevUnresolvedFault ||
        Boolean(hs.isCodeEditStep) ||
        hasDirectExecFault ||
        verifyFailCount > 0;
      stepLevel = immediateEscalate ? 'warn' : 'notice';
      stepBadge = immediateEscalate ? '卡顿缩水' : '浅思';
      detailParts.push(shockSqueezeProof);

      const ce = {
        sourceStep: st,
        sourceProof: shockSqueezeProof,
        escalated: immediateEscalate,
        remaining: IH_CONTAGION_WINDOW_STEPS,
        infected: [],
      };
      activeContagion = ce;
      if (Number.isInteger(st.turnIndex) && st.turnIndex > 0) {
        if (!contagionByTurn.has(st.turnIndex)) contagionByTurn.set(st.turnIndex, []);
        contagionByTurn.get(st.turnIndex).push(ce);
      }
    }

    if (infectedFromStepIdx !== null && !shockSqueeze) {
      detailParts.push(`受 #${infectedFromStepIdx} 浅思考传导`);
      stepLevel = ihMaxLevel(stepLevel, 'warn');
      stepBadge = '受传染';
    }

    // 6. 叠加内生行为异常信号
    if (identicalToolStreak >= 3) {
      stepLevel = 'critical';
      stepBadge = '死循环';
      detailParts.push(`同轮连续 ${identicalToolStreak} 次重复相同工具调用`);
    } else if (highRepeat) {
      stepLevel = 'critical';
      stepBadge = '复读';
      detailParts.push(`输出文本高度复读 (${Math.round((hs.outputRepeatRatio || 0) * 100)}%)`);
    }

    if (blindEditRetryCount > 0) {
      stepLevel = ihMaxLevel(stepLevel, 'warn');
      if (!stepBadge || stepBadge === '浅思' || stepBadge === '受传染') stepBadge = '盲改';
      detailParts.push(`编辑失败后未重读直接盲试 ${blindEditRetryCount} 次`);
    } else if (editFaultCount > 0) {
      stepLevel = ihMaxLevel(
        stepLevel,
        editFaultCount >= 2 || unshockedZeroThink || workerFault || infectedFromStepIdx !== null
          ? 'warn'
          : 'notice'
      );
      if (!stepBadge || stepBadge === '浅思' || stepBadge === '受传染') stepBadge = '失误';
      detailParts.push(`编辑原文匹配失败 ${editFaultCount} 次`);
    }

    if (toolFaultCount > 0) {
      stepLevel = ihMaxLevel(
        stepLevel,
        toolFaultCount >= 2 || prevUnresolvedFault || workerFault || infectedFromStepIdx !== null
          ? 'warn'
          : 'notice'
      );
      if (!stepBadge || stepBadge === '浅思' || stepBadge === '受传染') stepBadge = '失误';
      detailParts.push(
        `脚本报错 ${toolFaultCount} 次${toolFaultLabel ? ` (${toolFaultLabel})` : ''}`
      );
    }

    if (verifyFailStreak >= 3 && verifyFailCount > 0) {
      stepLevel = ihMaxLevel(stepLevel, verifyFailStreak >= 4 ? 'critical' : 'warn');
      if (!stepBadge || stepBadge === '浅思') stepBadge = '连败';
      detailParts.push(`测试/构建连续 ${verifyFailStreak} 次失败未收敛`);
    }

    if (thrashingEdits) {
      stepLevel = ihMaxLevel(stepLevel, oscillationRevertCount >= 2 ? 'warn' : 'warn');
      if (!stepBadge || stepBadge === '浅思') stepBadge = '返工';
      detailParts.push(
        oscillationRevertCount >= 2
          ? '同一代码片段来回撤销改写'
          : `同一代码区域连续覆写 ${sameRegionReworkCount} 次`
      );
    }

    if (amnesiaReadCount > 0) {
      const ctxNow = Number(
        st.contextTokens ||
          st.estimatedContextTokens ||
          (st.inputTokens || 0) + (st.cacheReadTokens || 0) ||
          0
      );
      const highCtxNow = ctxNow >= 180000;
      stepLevel = ihMaxLevel(
        stepLevel,
        amnesiaReadCount >= 2 || (highCtxNow && editFaultCount > 0) ? 'warn' : 'notice'
      );
      if (!stepBadge) stepBadge = '重读';
      detailParts.push(`重复重读未改静态文件 ${amnesiaReadCount} 次`);
    }

    if (unshockedZeroThink && (editFaultCount > 0 || toolFaultCount > 0 || thrashingEdits)) {
      stepLevel = ihMaxLevel(stepLevel, 'warn');
      if (!stepBadge) stepBadge = '零思';
      detailParts.push(`零思考仓促修改 (+${outTok} tok)`);
    } else if (infectedFromStepIdx !== null && unshockedZeroThink) {
      detailParts.push(`连续报错后可见思考归零 (+${outTok} tok)`);
    }

    if (readOnlyStreak >= 12 && stepLevel === 'healthy') {
      stepLevel = readOnlyStreak >= 18 ? 'critical' : 'warn';
      stepBadge = '空转';
      detailParts.push(`已连续 ${readOnlyStreak} 步纯只读检索未收敛`);
    }

    if (repeatedUpstreamFault && stepLevel === 'healthy') {
      stepLevel = 'notice';
      stepBadge = '重试';
      detailParts.push(
        cleanErrText
          ? `网关连续报错重试 (${cleanErrText})`
          : `网关连续重试 ${Math.max(upstreamErrCount, retryCount)} 次`
      );
    }

    if (workerFault) {
      detailParts.push('轻量执行层工具失误');
    }

    st.stepHealthLevel = stepLevel;
    st.stepHealthBadge = stepBadge;
    st.stepHealthDetail = detailParts.join(' · ');

    stepFindingsMap.set(st, {
      shockSqueeze,
      unshockedZeroThink,
      repeatedUpstreamFault,
      editFaultCount,
      blindEditRetryCount,
      toolFaultCount,
      verifyFailCount,
      verifyFailStreak,
      amnesiaReadCount,
      sameRegionReworkCount,
      oscillationRevertCount,
      readOnlyStreak,
      identicalToolStreak,
      thrashingEdits,
      highRepeat,
      workerFault,
      primaryReason: detailParts[0] || '',
    });

    // 更新跨步计划继承与未消解故障标志
    if (editFaultCount > 0 || toolFaultCount > 0 || verifyFailCount > 0) {
      prevUnresolvedFault = true;
    } else if (hs.cleanVerifyPass || (hasDeepThought && !shockSqueeze)) {
      prevUnresolvedFault = false;
    }

    if (hasDeepThought && !hasDirectExecFault && !shockSqueeze) {
      recentTurnPlanCarryover = 2;
    } else if (recentTurnPlanCarryover > 0) {
      recentTurnPlanCarryover -= 1;
    }

    prevNonCompact = st;
    prevIsWorker = isWorker;
  }

  // 按轮次（Turn）聚合诊断
  const stepsByTurn = new Map();
  let maxTurnIndex = 0;
  for (const st of steps) {
    const tIdx = st.turnIndex;
    if (!Number.isInteger(tIdx) || tIdx <= 0) {
      st.turnHealthScore = 100;
      st.turnHealthLevel = 'healthy';
      st.turnHealthStateLabel = '正常';
      continue;
    }
    if (tIdx > maxTurnIndex) maxTurnIndex = tIdx;
    if (!stepsByTurn.has(tIdx)) stepsByTurn.set(tIdx, []);
    stepsByTurn.get(tIdx).push(st);
  }

  const turnDiagnoses = [];
  const diagnosisByTurn = new Map();
  for (const [tIdx, tSteps] of stepsByTurn.entries()) {
    const diag = ihBuildTurnDiagnosis({
      turnIndex: tIdx,
      turnSteps: tSteps,
      stepFindingsMap,
      contagionEvents: contagionByTurn.get(tIdx) || [],
      agentId,
      agentBadge,
    });
    turnDiagnoses.push(diag);
    diagnosisByTurn.set(tIdx, diag);

    for (const st of tSteps) {
      st.turnHealthScore = diag.score;
      st.turnHealthLevel = diag.level;
      st.turnHealthStateLabel = diag.stateLabel;
      if (diag.level === 'warn' || diag.level === 'critical') {
        if (
          st.stepIndex === diag.anchorStepIndex &&
          (st.stepHealthLevel === 'healthy' || st.stepHealthLevel === 'notice')
        ) {
          st.stepHealthLevel = diag.level === 'critical' ? 'critical' : 'warn';
          if (!st.stepHealthBadge) {
            st.stepHealthBadge = st.healthSignals?.confirmedRollback ? '回滚' : diag.badge;
          }
        } else if (
          diag.category === 'context_rot' &&
          st.stepHealthBadge === '重读' &&
          st.stepHealthLevel === 'notice'
        ) {
          st.stepHealthLevel = 'warn';
        }
      }
    }
  }

  let anomalyStepCount = 0;
  for (const st of steps) {
    if (st.stepHealthLevel === 'warn' || st.stepHealthLevel === 'critical') {
      anomalyStepCount += 1;
    }
  }
  const anomalyTurns = turnDiagnoses.filter((d) => d.level === 'warn' || d.level === 'critical');
  const latestDiag = maxTurnIndex > 0 ? diagnosisByTurn.get(maxTurnIndex) : null;
  const activeAlert =
    latestDiag &&
    (latestDiag.level === 'warn' || latestDiag.level === 'critical') &&
    !latestDiag.isResolved
      ? latestDiag
      : null;

  const sessionLevel = activeAlert
    ? activeAlert.level
    : latestDiag
      ? latestDiag.level
      : anomalyTurns.length > 0
        ? 'notice'
        : 'healthy';
  const sessionStateLabel = formatHealthStateLabel(sessionLevel);
  const sessionScore = IH_COMPAT_ORDINAL_SCORE[sessionLevel] ?? 100;

  return {
    sessionScore,
    sessionLevel,
    sessionStateLabel,
    anomalyStepCount,
    anomalyTurnCount: anomalyTurns.length,
    activeAlert,
    turnDiagnoses,
  };
}

/**
 * 在多子代理（`All`）视图下合并主代理与所有子代理的健康诊断状态。
 */
export function mergeAggregatedInferenceHealth(
  mainHealth,
  subAgentTelemetries = [],
  combinedSteps = []
) {
  const rootDiagByTurn = new Map();
  if (mainHealth?.turnDiagnoses) {
    for (const d of mainHealth.turnDiagnoses) {
      rootDiagByTurn.set(d.turnIndex, d);
    }
  }

  for (const st of combinedSteps) {
    const rt = st.rootTurnIndex;
    const diag = Number.isInteger(rt) && rt > 0 ? rootDiagByTurn.get(rt) : null;
    if (diag) {
      st.rootTurnHealthScore = diag.score;
      st.rootTurnHealthLevel = diag.level;
      st.rootTurnHealthStateLabel = diag.stateLabel;
    }
  }

  let anomalyStepCount = 0;
  for (const st of combinedSteps) {
    if (st.stepHealthLevel === 'warn' || st.stepHealthLevel === 'critical') {
      anomalyStepCount += 1;
    }
  }

  let activeAlert = mainHealth?.activeAlert || null;
  if (!activeAlert) {
    const subAlerts = subAgentTelemetries
      .filter((s) => s?.inferenceHealth?.activeAlert)
      .sort((a, b) => (b.lastModifiedMs || 0) - (a.lastModifiedMs || 0));
    if (subAlerts.length > 0) {
      const sub = subAlerts[0];
      const subAlert = sub.inferenceHealth.activeAlert;
      activeAlert = {
        ...subAlert,
        title: `[${sub.badgeText || '子'}] ${subAlert.title}`,
        agentId: sub.agentId,
        agentBadge: sub.badgeText,
      };
    }
  }

  const turnDiagnoses = mainHealth?.turnDiagnoses || [];
  const anomalyTurnCount = turnDiagnoses.filter(
    (d) => d.level === 'warn' || d.level === 'critical'
  ).length;
  const sessionLevel = activeAlert
    ? activeAlert.level
    : mainHealth?.sessionLevel || 'healthy';
  const sessionStateLabel = formatHealthStateLabel(sessionLevel);
  const sessionScore = IH_COMPAT_ORDINAL_SCORE[sessionLevel] ?? 100;

  return {
    sessionScore,
    sessionLevel,
    sessionStateLabel,
    anomalyStepCount,
    anomalyTurnCount,
    activeAlert,
    turnDiagnoses,
  };
}
