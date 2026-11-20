/**
 * @fileoverview Preferences Tab 4: `SettingsDetectorTab.js` ("模型检测").
 * Non-semantic multi-probe black-box model identity detector for Antigravity host models,
 * defaulting to the active window model without polluting user conversations.
 */

import { defineComponent } from '../../core/component.js';
import {
  h,
  patchAttr,
  patchClasses,
  patchKeyedList,
  patchStyleVar,
  patchText,
} from '../../core/domPatch.js';
import { createSvgIcon } from '../../icons/SvgIcon.js';
import { t } from '../../i18n/index.js';
import {
  CURRENT_WINDOW_MODEL_VALUE,
  cancelModelDetection,
  fetchModelDetectorStatus,
  fetchTelemetry,
  syncModelDetector,
  telemetryStore,
  triggerModelDetection,
} from '../../store/telemetryStore.js';
import { uiStore } from '../../store/uiStore.js';
import { CustomSelect } from '../../components/ui/CustomSelect.js';
import { SegmentedControl } from '../../components/ui/SegmentedControl.js';

function getDetectorProbeModeOptions() {
  return [
    { value: 'fast', label: t('settings.det.modeFast') },
    { value: 'exact', label: t('settings.det.modeExact') },
  ];
}

function formatDetectorBankSubtext(bank) {
  if (!bank || !bank.ready) {
    return bank?.lastSyncError ? t('settings.det.bankError') : t('settings.det.bankLoading');
  }
  const srcText =
    bank.source === 'remote' ? t('settings.det.bankSrcRemote') : t('settings.det.bankSrcLocal');
  const datePart = bank.builtAt ? String(bank.builtAt).slice(0, 10) : '';
  if (Number(bank.lastCheckedAtMs) > 0) {
    const d = new Date(Number(bank.lastCheckedAtMs));
    const pad = (n) => String(n).padStart(2, '0');
    const timeStr = `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    return t('settings.det.bankCheckedAt', { src: srcText, time: timeStr });
  }
  return datePart ? `${srcText} · ${datePart}` : srcText;
}

function formatDetectorOptionMeta(model) {
  if (!model) return '';
  if (model.isQuotaExhausted) return t('settings.det.quotaExhausted');
  if (Number.isFinite(model.remainingPct)) {
    return t('settings.det.remQuota', { pct: model.remainingPct });
  }
  return model.tagTitle || '';
}

function formatDetectorHistoryClock(isoStr) {
  const ms = Date.parse(String(isoStr || ''));
  if (!Number.isFinite(ms)) return '';
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export const SettingsDetectorTab = defineComponent({
  name: 'SettingsDetectorTab',
  setup({ onCleanup, getProps }) {
    let selectedDetectorModelId = CURRENT_WINDOW_MODEL_VALUE;
    let detectorSnapshot = null;
    let inspectedHistoryId = '';
    let wasDetectorRunning = false;
    let detectorFeedbackTimer = null;
    let detectorPollTimer = null;

    const notifyLayout = () => {
      const fn = getProps()?.onLayoutChange;
      if (typeof fn === 'function') fn();
    };

    const detectorStatusMsg = h('span', {
      className: 'text-muted',
      style: 'font-size: var(--fs-md);',
      text: '',
    });

    function showDetectorFeedback(text, autoClearMs = 3500) {
      if (detectorFeedbackTimer) {
        clearTimeout(detectorFeedbackTimer);
        detectorFeedbackTimer = null;
      }
      patchText(detectorStatusMsg, text);
      if (text && autoClearMs > 0) {
        detectorFeedbackTimer = setTimeout(() => {
          detectorFeedbackTimer = null;
          patchText(detectorStatusMsg, '');
        }, autoClearMs);
      }
    }

    const detectorModelSelect = CustomSelect({
      modelValue: CURRENT_WINDOW_MODEL_VALUE,
      icon: 'fingerprint',
      options: [
        {
          value: CURRENT_WINDOW_MODEL_VALUE,
          label: t('settings.det.curWinAuto'),
          meta: t('settings.det.defaultMeta'),
        },
      ],
      onUpdateModelValue: (val) => {
        selectedDetectorModelId = val || CURRENT_WINDOW_MODEL_VALUE;
        renderDetectorSnapshot(detectorSnapshot);
      },
    });

    const detectorProbeModeSwitch = SegmentedControl({
      ariaLabel: t('settings.det.modeAria'),
      modelValue: uiStore.getState().detectorProbeMode || 'fast',
      options: getDetectorProbeModeOptions(),
      onUpdateModelValue: (nextMode) => {
        const mode = nextMode === 'exact' ? 'exact' : 'fast';
        uiStore.setState({ detectorProbeMode: mode });
        detectorProbeModeSwitch.setValue(mode);
      },
    });

    const controlTitleTextEl = h('span', { text: t('settings.det.title') });
    const modelFieldLabelEl = h('span', {
      className: 'form-label',
      text: t('settings.det.modelLabel'),
    });
    const modeFieldLabelEl = h('span', {
      className: 'form-label',
      text: t('settings.det.modeLabel'),
    });
    const agCellLabelEl = h('span', {
      className: 'cell-label',
      text: t('settings.det.agCellLabel'),
    });
    const bankCellLabelEl = h('span', {
      className: 'cell-label',
      text: t('settings.det.bankCellLabel'),
    });

    const agModelCountVal = h('strong', { className: 'cell-value', text: '—' });
    const agModelRefSub = h('span', {
      className: 'cell-sub',
      text: t('settings.det.agSyncing'),
    });
    const bankCountVal = h('strong', { className: 'cell-value', text: '—' });
    const bankSyncSub = h('span', {
      className: 'cell-sub',
      text: t('settings.det.bankLoading'),
    });

    const syncDetectorBtnText = h('span', { text: t('settings.det.syncBtn') });
    const startDetectBtnText = h('span', { text: t('settings.det.startBtn') });
    const cancelDetectBtnText = h('span', { text: t('settings.det.cancelBtn') });

    const syncDetectorBtn = h(
      'button',
      {
        type: 'button',
        className: 'btn-secondary',
        onclick: async () => {
          patchAttr(syncDetectorBtn, 'disabled', true);
          patchAttr(startDetectBtn, 'disabled', true);
          patchText(syncDetectorBtnText, t('settings.det.syncingBtn'));
          showDetectorFeedback(t('settings.det.syncingMsg'), 0);
          try {
            const res = await syncModelDetector({
              knownModels: detectorSnapshot?.availableModels || [],
            });
            if (res) {
              detectorSnapshot = res;
              renderDetectorSnapshot(res);
            }
            const sr = res?.syncResult;
            const agCount = Array.isArray(res?.availableModels) ? res.availableModels.length : 0;
            if (sr?.error) {
              showDetectorFeedback(
                t('settings.det.syncOfflineMsg', { count: agCount }),
                4500
              );
            } else if (sr?.updated) {
              showDetectorFeedback(
                t('settings.det.syncUpdatedMsg', {
                  bankCount: res?.bank?.modelCount || 0,
                  count: agCount,
                }),
                4000
              );
            } else {
              showDetectorFeedback(
                t('settings.det.syncUpToDateMsg', { count: agCount }),
                3500
              );
            }
          } catch (err) {
            showDetectorFeedback(err?.message || t('settings.det.syncFailedMsg'), 4500);
          } finally {
            patchText(syncDetectorBtnText, t('settings.det.syncBtn'));
            renderDetectorSnapshot(detectorSnapshot);
          }
        },
      },
      [createSvgIcon('refresh', { size: 12 }), syncDetectorBtnText]
    );

    const startDetectBtn = h(
      'button',
      {
        type: 'button',
        className: 'btn-primary',
        onclick: async () => {
          patchAttr(startDetectBtn, 'disabled', true);
          patchAttr(syncDetectorBtn, 'disabled', true);
          showDetectorFeedback(t('settings.det.startingMsg'), 0);
          try {
            const res = await triggerModelDetection({
              modelId: selectedDetectorModelId,
              probeMode: uiStore.getState().detectorProbeMode || 'fast',
              knownModels: detectorSnapshot?.availableModels || [],
            });
            inspectedHistoryId = '';
            if (res?.status) {
              wasDetectorRunning = Boolean(res.status.running?.active);
              detectorSnapshot = res.status;
              renderDetectorSnapshot(res.status);
              ensureDetectorPollLoop();
            }
            showDetectorFeedback('', 0);
          } catch (err) {
            showDetectorFeedback(err?.message || t('settings.det.startFailedMsg'), 4500);
            patchAttr(startDetectBtn, 'disabled', false);
            patchAttr(syncDetectorBtn, 'disabled', false);
          }
        },
      },
      [createSvgIcon('bolt', { size: 12 }), startDetectBtnText]
    );

    const detectorIdleActionsRow = h('div', { className: 'cloud-actions-row' }, [
      syncDetectorBtn,
      startDetectBtn,
    ]);

    const detectorProgressPhase = h('span', {
      className: 'detector-progress-phase',
      text: t('settings.det.runningDefault'),
    });
    const detectorProgressElapsed = h('span', {
      className: 'detector-progress-elapsed',
      text: '0.0s',
    });
    const detectorProgressFill = h('div', { className: 'progress-fill' });
    patchStyleVar(detectorProgressFill, '--fill-w', '12%');

    const cancelDetectBtn = h(
      'button',
      {
        type: 'button',
        className: 'btn-secondary',
        onclick: async () => {
          patchAttr(cancelDetectBtn, 'disabled', true);
          try {
            const res = await cancelModelDetection({
              knownModels: detectorSnapshot?.availableModels || [],
            });
            stopDetectorPollLoop();
            wasDetectorRunning = false;
            if (res?.status) {
              detectorSnapshot = res.status;
              renderDetectorSnapshot(res.status);
            }
            showDetectorFeedback(t('settings.det.canceledMsg'), 2200);
          } catch (err) {
            showDetectorFeedback(err?.message || t('settings.det.cancelFailedMsg'), 3000);
          } finally {
            patchAttr(cancelDetectBtn, 'disabled', false);
          }
        },
      },
      [createSvgIcon('close', { size: 12 }), cancelDetectBtnText]
    );

    const detectorProgressBox = h(
      'div',
      { className: 'detector-progress-box', hidden: true },
      [
        h('div', { className: 'detector-progress-head' }, [
          detectorProgressPhase,
          detectorProgressElapsed,
        ]),
        h('div', { className: 'progress-track' }, [detectorProgressFill]),
        h('div', { className: 'cloud-actions-row' }, [cancelDetectBtn]),
      ]
    );

    const detectorControlPanel = h('section', { className: 'panel' }, [
      h('div', { className: 'panel-header' }, [
        h('span', { className: 'panel-title' }, [
          createSvgIcon('fingerprint', { size: 13 }),
          controlTitleTextEl,
        ]),
        detectorStatusMsg,
      ]),
      h('div', { className: 'form-row' }, [
        modelFieldLabelEl,
        h('div', { className: 'detector-select-box' }, [detectorModelSelect.el]),
      ]),
      h('div', { className: 'settings-inline-row detector-mode-row' }, [
        modeFieldLabelEl,
        detectorProbeModeSwitch.el,
      ]),
      h('div', { className: 'dual-grid' }, [
        h('div', { className: 'matrix-cell' }, [agCellLabelEl, agModelCountVal, agModelRefSub]),
        h('div', { className: 'matrix-cell' }, [bankCellLabelEl, bankCountVal, bankSyncSub]),
      ]),
      detectorIdleActionsRow,
      detectorProgressBox,
    ]);

    const verdictTitleTextEl = h('span', { text: t('settings.det.verdictTitle') });
    const verdictMetaText = h('span', { className: 'panel-meta detector-verdict-meta', text: '' });
    const detectorEmptyNote = h('div', {
      className: 'detector-empty-note',
      text: t('settings.det.emptyNote'),
    });

    const verdictStatusTag = h('span', { className: 'status-tag', text: t('settings.det.doneBadge') });
    const verdictTargetText = h('span', { className: 'detector-verdict-target', text: '' });
    const verdictHeadline = h('div', { className: 'detector-headline', text: '' });
    const verdictDetail = h('div', { className: 'detector-detail', text: '' });

    const candidateListEl = h('div', { className: 'detector-candidates', hidden: true });
    const historyLabelEl = h('span', {
      className: 'detector-history-label',
      text: t('settings.det.historyTitle'),
    });
    const historyListEl = h('div', { className: 'detector-history-list' });
    const historySectionEl = h(
      'div',
      { className: 'detector-history-section', hidden: true },
      [historyLabelEl, historyListEl]
    );

    const detectorVerdictBody = h(
      'div',
      { className: 'detector-verdict-body', hidden: true },
      [
        h('div', { className: 'detector-verdict-box' }, [
          h('div', { className: 'detector-verdict-top' }, [
            h('div', { className: 'detector-verdict-left' }, [
              verdictStatusTag,
              verdictTargetText,
            ]),
          ]),
          verdictHeadline,
          verdictDetail,
        ]),
        candidateListEl,
        historySectionEl,
      ]
    );

    const detectorResultPanel = h('section', { className: 'panel' }, [
      h('div', { className: 'panel-header' }, [
        h('span', { className: 'panel-title' }, [
          createSvgIcon('pulse', { size: 13 }),
          verdictTitleTextEl,
        ]),
        verdictMetaText,
      ]),
      detectorEmptyNote,
      detectorVerdictBody,
    ]);

    const rootEl = h('div', { className: 'settings-tab-stack' }, [
      detectorControlPanel,
      detectorResultPanel,
    ]);

    function renderDetectorSnapshot(snap) {
      if (!snap) return;
      const models = Array.isArray(snap.availableModels) ? snap.availableModels : [];
      const curWin = snap.currentWindowModel || null;
      const bank = snap.bank || null;
      const running = snap.running?.active ? snap.running : null;

      if (
        selectedDetectorModelId !== CURRENT_WINDOW_MODEL_VALUE &&
        models.length > 0 &&
        !models.some((m) => m.modelId === selectedDetectorModelId)
      ) {
        selectedDetectorModelId = CURRENT_WINDOW_MODEL_VALUE;
      }

      const curLabel = curWin?.label
        ? t('settings.det.curWinNamed', { label: curWin.label })
        : t('settings.det.curWinAuto');
      const curMeta = curWin
        ? formatDetectorOptionMeta(curWin) || t('settings.det.defaultMeta')
        : t('settings.det.defaultMeta');

      const selectOptions = [
        {
          value: CURRENT_WINDOW_MODEL_VALUE,
          label: curLabel,
          meta: curMeta,
        },
        ...models.map((m) => ({
          value: m.modelId,
          label: m.label,
          meta: formatDetectorOptionMeta(m),
        })),
      ];
      detectorModelSelect.setProps({
        modelValue: selectedDetectorModelId,
        options: selectOptions,
      });

      const activeTarget =
        selectedDetectorModelId === CURRENT_WINDOW_MODEL_VALUE
          ? curWin || models[0] || null
          : models.find((m) => m.modelId === selectedDetectorModelId) || null;

      patchText(
        agModelCountVal,
        models.length > 0
          ? t('settings.det.agCount', { count: models.length })
          : t('settings.det.agLoading')
      );
      if (activeTarget) {
        const refText =
          activeTarget.reference && activeTarget.reference !== 'unknown'
            ? t('settings.det.agRefMatch', { ref: activeTarget.reference })
            : t('settings.det.agOpenSync');
        patchText(agModelRefSub, refText);
      } else {
        patchText(agModelRefSub, t('settings.det.agAutoHost'));
      }

      patchText(
        bankCountVal,
        bank?.ready
          ? t('settings.det.bankCount', { count: bank.modelCount || 0 })
          : t('settings.det.bankNotReady')
      );
      patchText(bankSyncSub, formatDetectorBankSubtext(bank));

      const isBusy = Boolean(running);
      patchAttr(detectorIdleActionsRow, 'hidden', isBusy);
      patchAttr(detectorProgressBox, 'hidden', !isBusy);
      patchAttr(syncDetectorBtn, 'disabled', isBusy || Boolean(bank?.isSyncing));
      patchAttr(startDetectBtn, 'disabled', isBusy || !bank?.ready || models.length === 0);

      if (running) {
        patchText(
          detectorProgressPhase,
          running.phaseText ||
            t('settings.det.runningTarget', { target: running.targetLabel || '' })
        );
        const sec = ((running.elapsedMs || 0) / 1000).toFixed(1);
        patchText(detectorProgressElapsed, `${sec}s`);
        const completed = Number(running.completedProbes || 0);
        const total = Math.max(1, Number(running.totalProbes || 3));
        const liveNums = Number(running.liveParsedNumbers || 0);
        const expectedNums = Math.max(300, Number(running.expectedTotalNumbers || 900));
        const activeThinking = Number(running.activeThinkingProbes || 0);
        let pct = 14;
        if (completed >= total) {
          pct = 94;
        } else {
          const donePct = (completed / total) * 74;
          const streamPct = Math.min(0.95, liveNums / expectedNums) * 74;
          const thinkBoost = activeThinking > 0 ? Math.min(18, activeThinking * 5) : 0;
          pct = Math.round(14 + Math.max(donePct, streamPct, thinkBoost));
        }
        patchStyleVar(detectorProgressFill, '--fill-w', `${Math.max(12, Math.min(95, pct))}%`);
      }

      const history = Array.isArray(snap.history) ? snap.history : [];
      const activeRecord =
        (inspectedHistoryId && history.find((item) => item?.id === inspectedHistoryId)) ||
        snap.latestResult ||
        history[0] ||
        null;

      if (!activeRecord) {
        patchAttr(detectorEmptyNote, 'hidden', false);
        patchAttr(detectorVerdictBody, 'hidden', true);
        patchText(verdictMetaText, '');
      } else {
        patchAttr(detectorEmptyNote, 'hidden', true);
        patchAttr(detectorVerdictBody, 'hidden', false);

        const tone = activeRecord.summary?.tone || 'neutral';
        patchText(verdictStatusTag, activeRecord.summary?.badge || t('settings.det.doneBadge'));
        patchClasses(verdictStatusTag, {
          'state-synced': tone === 'ok' || tone === 'good' || tone === 'info',
          'state-warn': tone === 'warn',
          'state-danger': tone === 'bad',
          'state-neutral': tone === 'neutral',
        });

        const targetSuffix = activeRecord.usedCurrentWindowDefault
          ? t('settings.det.curWinSuffix')
          : '';
        patchText(
          verdictTargetText,
          `${activeRecord.targetLabel || activeRecord.targetModelId || ''}${targetSuffix}`
        );
        patchText(verdictHeadline, activeRecord.summary?.headline || '');
        patchText(verdictDetail, activeRecord.summary?.detail || '');

        const durSec = Number.isFinite(activeRecord.elapsedMs)
          ? `${(activeRecord.elapsedMs / 1000).toFixed(1)}s`
          : '';
        const sampleMeta =
          activeRecord.usedOutputs > 0
            ? t('settings.det.sampleMeta', {
                used: activeRecord.usedOutputs,
                nums: activeRecord.totalNumbers || 0,
              })
            : '';
        const modeMeta = activeRecord.ok
          ? activeRecord.fastTierRouted
            ? t('settings.det.modeFast')
            : activeRecord.probeMode === 'exact'
              ? t('settings.det.modeExact')
              : ''
          : '';
        patchText(verdictMetaText, [durSec, sampleMeta, modeMeta].filter(Boolean).join(' · '));

        const topCands = Array.isArray(activeRecord.topCandidates)
          ? activeRecord.topCandidates.slice(0, 3)
          : [];
        patchAttr(candidateListEl, 'hidden', topCands.length === 0);

        if (topCands.length > 0) {
          const maxRaw = Math.max(
            ...topCands.map((c) => Number(c.rawScore ?? c.score ?? 0)),
            1e-6
          );
          const minRaw = Math.min(
            ...topCands.map((c) => Number(c.rawScore ?? c.score ?? 0)),
            0
          );
          const spanRaw = Math.max(maxRaw - minRaw, 1e-6);

          patchKeyedList(candidateListEl, topCands, {
            keyFn: (cand) => cand.model || cand.label,
            sigFn: (cand, idx) =>
              `${idx}::${cand.label}::${cand.probability ?? ''}::${cand.score ?? ''}`,
            createRow: () => {
              const rankEl = h('span', { className: 'detector-cand-rank' });
              const nameEl = h('span', { className: 'detector-cand-name' });
              const fillEl = h('div', { className: 'detector-cand-fill' });
              const trackEl = h('div', { className: 'detector-cand-track' }, [fillEl]);
              const pctEl = h('span', { className: 'detector-cand-pct' });
              const rowEl = h('div', { className: 'detector-cand-row' }, [
                rankEl,
                nameEl,
                trackEl,
                pctEl,
              ]);
              return { el: rowEl, refs: { rankEl, nameEl, fillEl, pctEl } };
            },
            updateRow: (refs, cand, idx, rowEl) => {
              patchClasses(rowEl, { 'is-top': idx === 0 });
              patchText(refs.rankEl, `#${idx + 1}`);
              patchText(refs.nameEl, cand.label || cand.model || '');
              patchAttr(
                refs.nameEl,
                'title',
                cand.familyName ? `${cand.label} (${cand.familyName})` : cand.label || ''
              );
              if (Number.isFinite(cand.probability)) {
                const pct = Math.max(0, Math.min(100, cand.probability * 100));
                patchStyleVar(refs.fillEl, '--cand-w', `${Math.max(4, Math.round(pct))}%`);
                patchText(refs.pctEl, `${pct.toFixed(1)}%`);
              } else {
                const rel = Math.round(
                  25 + ((Number(cand.rawScore ?? cand.score ?? 0) - minRaw) / spanRaw) * 75
                );
                patchStyleVar(refs.fillEl, '--cand-w', `${Math.max(8, Math.min(100, rel))}%`);
                patchText(refs.pctEl, Number(cand.score ?? 0).toFixed(2));
              }
            },
          });
        }

        const showHistory = history.length > 1;
        patchAttr(historySectionEl, 'hidden', !showHistory);
        if (showHistory) {
          const histSlice = history.slice(0, 4);
          patchKeyedList(historyListEl, histSlice, {
            keyFn: (item) => item.id,
            sigFn: (item) =>
              `${item.id}::${item.id === activeRecord.id}::${item.summary?.badge || ''}::${item.targetLabel || ''}`,
            createRow: (item) => {
              const badgeEl = h('span', { className: 'detector-history-badge' });
              const modelEl = h('span', { className: 'detector-history-model' });
              const timeEl = h('span', { className: 'detector-history-time' });
              const btnEl = h(
                'button',
                {
                  type: 'button',
                  className: 'detector-history-item',
                  onclick: () => {
                    inspectedHistoryId = item.id;
                    renderDetectorSnapshot(detectorSnapshot);
                  },
                },
                [
                  h('span', { className: 'detector-history-item-left' }, [badgeEl, modelEl]),
                  timeEl,
                ]
              );
              return { el: btnEl, refs: { badgeEl, modelEl, timeEl } };
            },
            updateRow: (refs, item, _idx, btnEl) => {
              const selected = item.id === activeRecord.id;
              const hTone = item.summary?.tone || 'neutral';
              patchClasses(btnEl, { 'is-selected': selected });
              patchText(refs.badgeEl, item.summary?.badge || t('settings.det.doneBadge'));
              patchClasses(refs.badgeEl, {
                'tone-good': hTone === 'ok' || hTone === 'good',
                'tone-info': hTone === 'info',
                'tone-warn': hTone === 'warn',
                'tone-bad': hTone === 'bad',
              });
              patchText(refs.modelEl, item.targetLabel || item.targetModelId || '');
              patchText(refs.timeEl, formatDetectorHistoryClock(item.createdAt));
            },
          });
        }
      }

      notifyLayout();
    }

    function stopDetectorPollLoop() {
      if (detectorPollTimer) {
        clearTimeout(detectorPollTimer);
        detectorPollTimer = null;
      }
    }

    async function refreshDetectorStatus({ force = false } = {}) {
      try {
        const snap = await fetchModelDetectorStatus({
          force,
          knownModels: detectorSnapshot?.availableModels || [],
        });
        if (!snap) return;
        const nowRunning = Boolean(snap.running?.active);
        if (wasDetectorRunning && !nowRunning) {
          inspectedHistoryId = '';
          void fetchTelemetry({ force: true });
        }
        wasDetectorRunning = nowRunning;
        detectorSnapshot = snap;
        renderDetectorSnapshot(snap);
        if (nowRunning) {
          ensureDetectorPollLoop();
        } else {
          stopDetectorPollLoop();
        }
      } catch {
        // Ignore transient poll jitter
      }
    }

    function ensureDetectorPollLoop() {
      if (detectorPollTimer) return;
      const tick = async () => {
        detectorPollTimer = null;
        if (!detectorSnapshot?.running?.active) return;
        await refreshDetectorStatus({ force: false });
        if (detectorSnapshot?.running?.active && !detectorPollTimer) {
          detectorPollTimer = setTimeout(tick, 850);
        }
      };
      detectorPollTimer = setTimeout(tick, 850);
    }

    function activate() {
      void refreshDetectorStatus({ force: false });
    }

    function deactivate() {
      stopDetectorPollLoop();
      detectorModelSelect.close();
    }

    function refreshLabels() {
      patchText(controlTitleTextEl, t('settings.det.title'));
      patchText(modelFieldLabelEl, t('settings.det.modelLabel'));
      patchText(modeFieldLabelEl, t('settings.det.modeLabel'));
      patchText(agCellLabelEl, t('settings.det.agCellLabel'));
      patchText(bankCellLabelEl, t('settings.det.bankCellLabel'));
      patchText(syncDetectorBtnText, t('settings.det.syncBtn'));
      patchText(startDetectBtnText, t('settings.det.startBtn'));
      patchText(cancelDetectBtnText, t('settings.det.cancelBtn'));
      patchText(verdictTitleTextEl, t('settings.det.verdictTitle'));
      patchText(detectorEmptyNote, t('settings.det.emptyNote'));
      patchText(historyLabelEl, t('settings.det.historyTitle'));
      detectorProbeModeSwitch.setProps({
        ariaLabel: t('settings.det.modeAria'),
        modelValue: uiStore.getState().detectorProbeMode || 'fast',
        options: getDetectorProbeModeOptions(),
      });
      if (detectorSnapshot) {
        renderDetectorSnapshot(detectorSnapshot);
      } else {
        detectorModelSelect.setProps({
          modelValue: selectedDetectorModelId,
          options: [
            {
              value: CURRENT_WINDOW_MODEL_VALUE,
              label: t('settings.det.curWinAuto'),
              meta: t('settings.det.defaultMeta'),
            },
          ],
        });
        patchText(agModelRefSub, t('settings.det.agSyncing'));
        patchText(bankSyncSub, t('settings.det.bankLoading'));
      }
    }

    let prevActiveCascadeId =
      telemetryStore.getState().telemetry?.activeConversation?.cascadeId || '';
    const unsubTelemetry = telemetryStore.subscribe(
      (st) => st.telemetry?.activeConversation?.cascadeId || '',
      (nextCid) => {
        if (nextCid === prevActiveCascadeId) return;
        prevActiveCascadeId = nextCid;
        if (!rootEl.hasAttribute('hidden')) {
          void refreshDetectorStatus({ force: false });
        }
      }
    );

    onCleanup(() => {
      unsubTelemetry();
      stopDetectorPollLoop();
      if (detectorFeedbackTimer) {
        clearTimeout(detectorFeedbackTimer);
        detectorFeedbackTimer = null;
      }
      detectorModelSelect.destroy();
      detectorProbeModeSwitch.destroy();
    });

    return {
      el: rootEl,
      refs: {
        detectorModelSelect,
        detectorProbeModeSwitch,
        syncDetectorBtn,
        startDetectBtn,
        cancelDetectBtn,
        activate,
        deactivate,
        refreshDetectorStatus,
        renderDetectorSnapshot,
        refreshLabels,
      },
    };
  },
});
