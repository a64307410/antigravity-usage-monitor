/**
 * @fileoverview View 1: Decoupled `LiveOverviewView.js` (实时监控视图).
 * Acts as a lightweight host container delegating all telemetry cards
 * (`metrics`, `context`, `quotas`, `live_tasks`) to `widgetRegistry.js` (`a` calls `b`),
 * allowing users to freely reorder or remove any module down to 1 item.
 */

import { defineComponent } from '../core/component.js';
import { h, patchAttr, patchClasses, patchText } from '../core/domPatch.js';
import { copyWithTimedFeedback } from '../core/httpClient.js';
import { createSvgIcon, patchSvgIcon } from '../icons/SvgIcon.js';
import { i18nStore, t } from '../i18n/index.js';
import { createDynamicWidgetHost } from '../registries/widgetRegistry.js';
import {
  DEFAULT_CLIENT_OVERVIEW_MODULES,
  normalizeClientOverviewModules,
  resolveScopedConversation,
  telemetryStore,
} from '../store/telemetryStore.js';
import { getVisibleMonitorView, uiStore } from '../store/uiStore.js';
import { CustomScrollbar } from '../components/ui/CustomScrollbar.js';

export { CTX_CHANNEL_DEFS } from '../components/widgets/ContextWindowWidget.js';
export {
  buildQuotaPoolItems,
  createPoolQuotaRow,
  formatQuotaSummaryFooter,
  quotaPoolRowSig,
  syncPoolQuotaRow,
} from '../components/widgets/QuotaPoolsWidget.js';

export const LiveOverviewView = defineComponent({
  name: 'LiveOverviewView',
  setup({ onCleanup }) {
    const primaryCopyTimer = { id: null };
    const secondaryCopyTimer = { id: null };
    let activeRenderedAlert = null;
    const boundActionMap = new Map();

    const healthBadgeEl = h('span', {
      className: 'health-cat-badge',
      text: t('health.badgeFallback'),
    });
    const healthTitleEl = h('strong', { className: 'health-alert-title', text: '' });
    const healthScoreEl = h('span', { className: 'health-score-pill text-mono', text: '' });
    const healthDismissBtn = h(
      'button',
      {
        type: 'button',
        className: 'icon-btn health-dismiss-btn',
        'aria-label': t('health.dismissAria'),
        title: t('health.dismissTitle'),
        onclick: () => {
          if (activeRenderedAlert?.alertKey) {
            uiStore.setState({ dismissedHealthAlertKey: activeRenderedAlert.alertKey });
          }
        },
      },
      [createSvgIcon('close', { size: 11 })]
    );
    const healthSummaryEl = h('div', { className: 'health-alert-summary', text: '' });
    const healthReasonSlots = [0, 1, 2].map(() =>
      h('div', { className: 'health-reason-item text-mono', hidden: true, text: '' })
    );
    const healthReasonsEl = h('div', { className: 'health-reasons-list' }, healthReasonSlots);

    function jumpToHealthStep(stepIndex, agentId) {
      if (stepIndex == null || !Number.isFinite(Number(stepIndex))) return;
      const now = Date.now();
      uiStore.setState({
        activeView: 'steps',
        stepsSubTab: 'steps',
        ...(agentId && agentId !== 'main' && agentId !== 'all'
          ? { selectedAgentScope: agentId }
          : {}),
        highlightedStepTarget: {
          cascadeId: latestData?.activeConversation?.cascadeId || '',
          agentId: agentId || '',
          stepIndex: Number(stepIndex),
          ts: now,
          seq: now,
        },
      });
    }

    async function invokeBoundHealthAction(btnEl) {
      const spec = boundActionMap.get(btnEl);
      if (!spec?.action) return;
      const { action, iconEl, labelEl, timerSlot } = spec;
      if (action.kind === 'copy') {
        await copyWithTimedFeedback(action.copyText, timerSlot, (copied) => {
          patchSvgIcon(iconEl, copied ? 'check' : 'copy');
          patchText(
            labelEl,
            copied ? action.toast || t('health.copiedToast') : action.label || ''
          );
          patchClasses(btnEl, { 'is-copied': copied });
        });
      } else if (action.kind === 'jump_step') {
        jumpToHealthStep(action.stepIndex, action.agentId);
      }
    }

    function bindHealthActionButton(btnEl, iconEl, labelEl, action, timerSlot, defaultClass) {
      if (!action) {
        patchAttr(btnEl, 'hidden', true);
        boundActionMap.delete(btnEl);
        return;
      }
      patchAttr(btnEl, 'hidden', false);
      const isCopy = action.kind === 'copy';
      patchSvgIcon(iconEl, isCopy ? 'copy' : 'table');
      patchText(labelEl, action.label || '');
      patchAttr(btnEl, 'class', defaultClass);
      boundActionMap.set(btnEl, { action, iconEl, labelEl, timerSlot });
    }

    const primaryBtnIcon = createSvgIcon('copy', { size: 11 });
    const primaryBtnLabel = h('span', { text: '' });
    const healthPrimaryBtn = h(
      'button',
      {
        type: 'button',
        className: 'btn-health-action is-primary',
        hidden: true,
        onclick: () => void invokeBoundHealthAction(healthPrimaryBtn),
      },
      [primaryBtnIcon, primaryBtnLabel]
    );

    const secondaryBtnIcon = createSvgIcon('copy', { size: 11 });
    const secondaryBtnLabel = h('span', { text: '' });
    const healthSecondaryBtn = h(
      'button',
      {
        type: 'button',
        className: 'btn-health-action',
        hidden: true,
        onclick: () => void invokeBoundHealthAction(healthSecondaryBtn),
      },
      [secondaryBtnIcon, secondaryBtnLabel]
    );

    const jumpBtnIcon = createSvgIcon('table', { size: 11 });
    const jumpBtnLabel = h('span', { text: '' });
    const healthJumpBtn = h(
      'button',
      {
        type: 'button',
        className: 'btn-health-action is-ghost',
        hidden: true,
        onclick: () => void invokeBoundHealthAction(healthJumpBtn),
      },
      [jumpBtnIcon, jumpBtnLabel]
    );

    const healthAlertPanel = h(
      'section',
      { className: 'panel health-alert-panel', hidden: true },
      [
        h('div', { className: 'health-alert-head' }, [
          h('div', { className: 'health-alert-title-wrap' }, [
            createSvgIcon('warning', { size: 13, className: 'health-alert-icon' }),
            healthBadgeEl,
            healthTitleEl,
          ]),
          h('div', { className: 'health-alert-head-right' }, [
            healthScoreEl,
            healthDismissBtn,
          ]),
        ]),
        healthSummaryEl,
        healthReasonsEl,
        h('div', { className: 'health-alert-actions' }, [
          healthPrimaryBtn,
          healthSecondaryBtn,
          healthJumpBtn,
        ]),
      ]
    );

    function renderHealthAlert(data) {
      if (!data) {
        patchAttr(healthAlertPanel, 'hidden', true);
        activeRenderedAlert = null;
        return;
      }
      const uiSt = uiStore.getState();
      const { scopedConv, ctxAgent } = resolveScopedConversation(
        data,
        'all',
        uiSt.ctxInspectorAgentId
      );
      const active =
        (uiSt.ctxInspectorAgentId && uiSt.ctxInspectorAgentId !== 'auto' ? ctxAgent : null) ||
        scopedConv ||
        data.activeConversation ||
        {};
      const healthInfo =
        active.inferenceHealth ||
        data.activeConversation?.aggregated?.inferenceHealth ||
        data.activeConversation?.inferenceHealth ||
        null;
      const rawAlert = healthInfo?.activeAlert || null;
      const showAlert = Boolean(
        rawAlert && rawAlert.alertKey && rawAlert.alertKey !== uiSt.dismissedHealthAlertKey
      );
      patchAttr(healthAlertPanel, 'hidden', !showAlert);
      if (!showAlert) {
        activeRenderedAlert = null;
        return;
      }
      activeRenderedAlert = rawAlert;
      patchClasses(healthAlertPanel, { 'is-critical': rawAlert.level === 'critical' });
      patchText(healthBadgeEl, rawAlert.badge || t('health.badgeFallback'));
      patchText(healthTitleEl, rawAlert.title || t('health.titleFallback'));
      patchAttr(healthTitleEl, 'title', rawAlert.title || '');
      patchAttr(healthDismissBtn, 'aria-label', t('health.dismissAria'));
      patchAttr(healthDismissBtn, 'title', t('health.dismissTitle'));
      const alertStateWord =
        rawAlert.stateLabel ||
        (rawAlert.level === 'critical' ? t('health.stateCritical') : t('health.stateWarn'));
      patchText(
        healthScoreEl,
        rawAlert.turnIndex
          ? t('health.turnPill', { turn: rawAlert.turnIndex, state: alertStateWord })
          : alertStateWord
      );
      patchText(healthSummaryEl, rawAlert.summary || '');
      const reasons = Array.isArray(rawAlert.reasons) ? rawAlert.reasons : [];
      patchAttr(healthReasonsEl, 'hidden', reasons.length === 0);
      for (let rIdx = 0; rIdx < healthReasonSlots.length; rIdx++) {
        const rText = reasons[rIdx] || '';
        patchAttr(healthReasonSlots[rIdx], 'hidden', !rText);
        patchText(healthReasonSlots[rIdx], rText);
      }
      bindHealthActionButton(
        healthPrimaryBtn,
        primaryBtnIcon,
        primaryBtnLabel,
        rawAlert.primaryAction,
        primaryCopyTimer,
        'btn-health-action is-primary'
      );
      bindHealthActionButton(
        healthSecondaryBtn,
        secondaryBtnIcon,
        secondaryBtnLabel,
        rawAlert.secondaryAction,
        secondaryCopyTimer,
        'btn-health-action'
      );
      const bothCopy =
        rawAlert.primaryAction?.kind === 'copy' && rawAlert.secondaryAction?.kind === 'copy';
      const showExtraJump = bothCopy && rawAlert.anchorStepIndex != null;
      if (showExtraJump) {
        bindHealthActionButton(
          healthJumpBtn,
          jumpBtnIcon,
          jumpBtnLabel,
          {
            kind: 'jump_step',
            label: t('health.jumpLabel', { step: rawAlert.anchorStepIndex }),
            stepIndex: rawAlert.anchorStepIndex,
            agentId: rawAlert.agentId,
          },
          primaryCopyTimer,
          'btn-health-action is-ghost'
        );
      } else {
        patchAttr(healthJumpBtn, 'hidden', true);
        boundActionMap.delete(healthJumpBtn);
      }
    }

    const overviewInner = h('div', {
      className: 'overview-modules-host',
    });

    const widgetHost = createDynamicWidgetHost({
      containerEl: overviewInner,
      mode: 'overview',
      isVisibleFn: () => getVisibleMonitorView() === 'overview',
      initialModuleKeys: DEFAULT_CLIENT_OVERVIEW_MODULES,
    });

    const overviewScrollRoot = h(
      'div',
      { className: 'overview-scroll-root' },
      [healthAlertPanel, overviewInner]
    );

    const viewScrollbar = CustomScrollbar({
      contentEl: overviewScrollRoot,
      className: 'view-pane',
    });

    let latestData = null;
    let isDirty = false;
    let countdownTickTimer = null;

    function stopCountdownTicker() {
      if (countdownTickTimer) {
        clearInterval(countdownTickTimer);
        countdownTickTimer = null;
      }
    }

    function ensureCountdownTicker() {
      if (getVisibleMonitorView() !== 'overview') {
        stopCountdownTicker();
        return;
      }
      if (!countdownTickTimer) {
        countdownTickTimer = setInterval(() => {
          if (getVisibleMonitorView() === 'overview' && latestData) {
            renderData(latestData);
          }
        }, 30_000);
      }
    }

    function renderData(data) {
      if (!data) return;
      renderHealthAlert(data);
      const moduleKeys = normalizeClientOverviewModules(data.settings?.overviewModules);
      const minuteTick = Math.floor(Date.now() / 30000);
      widgetHost.update({
        moduleKeys,
        data,
        minuteTick,
      });
      ensureCountdownTicker();
      viewScrollbar.refresh();
    }

    const unsubTelemetry = telemetryStore.subscribe(
      (st) => ({ telemetry: st.telemetry, minuteTick: st.minuteTick }),
      ({ telemetry: data }) => {
        latestData = data;
        if (getVisibleMonitorView() !== 'overview') {
          const stillRunning =
            (Array.isArray(data?.runningConversations) && data.runningConversations.length > 0) ||
            Boolean(
              data?.activeConversation?.isRunning ||
                data?.activeConversation?.aggregated?.isRunning
            );
          if (!stillRunning) {
            widgetHost.pauseTickers();
          }
          isDirty = true;
          return;
        }
        isDirty = false;
        renderData(data);
      }
    );

    let prevCtxTarget = uiStore.getState().ctxInspectorAgentId;
    let prevDismissedAlertKey = uiStore.getState().dismissedHealthAlertKey;

    const unsubView = uiStore.subscribe(
      (st) => ({
        activeView: getVisibleMonitorView(st),
        ctxInspectorAgentId: st.ctxInspectorAgentId,
        dismissedHealthAlertKey: st.dismissedHealthAlertKey,
      }),
      (slice) => {
        const scopeChanged =
          slice.ctxInspectorAgentId !== prevCtxTarget ||
          slice.dismissedHealthAlertKey !== prevDismissedAlertKey;
        prevCtxTarget = slice.ctxInspectorAgentId;
        prevDismissedAlertKey = slice.dismissedHealthAlertKey;

        if (slice.activeView !== 'overview') {
          widgetHost.pauseTickers();
          stopCountdownTicker();
          if (scopeChanged) isDirty = true;
          return;
        }
        ensureCountdownTicker();
        if ((isDirty || scopeChanged) && latestData) {
          isDirty = false;
          renderData(latestData);
        } else {
          widgetHost.resumeTickers();
        }
      }
    );

    const unsubI18n = i18nStore.subscribe(
      (st) => st.locale,
      () => {
        if (getVisibleMonitorView() !== 'overview') {
          isDirty = true;
          // Refresh initial skeleton labels even before telemetry arrives
          if (!latestData) {
            widgetHost.update({
              moduleKeys: DEFAULT_CLIENT_OVERVIEW_MODULES,
              data: null,
            });
          }
          return;
        }
        if (latestData) {
          renderData(latestData);
        } else {
          widgetHost.update({
            moduleKeys: DEFAULT_CLIENT_OVERVIEW_MODULES,
            data: null,
          });
        }
      }
    );

    onCleanup(() => {
      if (primaryCopyTimer.id) {
        clearTimeout(primaryCopyTimer.id);
        primaryCopyTimer.id = null;
      }
      if (secondaryCopyTimer.id) {
        clearTimeout(secondaryCopyTimer.id);
        secondaryCopyTimer.id = null;
      }
      stopCountdownTicker();
      unsubTelemetry();
      unsubView();
      unsubI18n();
      widgetHost.destroy();
      viewScrollbar.destroy();
    });

    return {
      el: viewScrollbar.el,
      refs: { viewScrollbar, widgetHost, healthAlertPanel },
    };
  },
});
