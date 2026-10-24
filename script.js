/* =========================================================
   HMI Finance — Monthly Target & Daily Progress Tracker
   Vanilla JS + Firebase Auth + Firestore (data stored per user in the cloud).
   ========================================================= */

(function () {
  "use strict";

  const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const EPS = 0.005;

  /* -----------------------------------------------------
     Date helpers
  ----------------------------------------------------- */
  function todayISO() {
    return dateToISO(new Date());
  }
  function dateToISO(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }
  function isoToDate(iso) {
    const [y, m, d] = iso.split("-").map(Number);
    return new Date(y, m - 1, d);
  }
  function addDaysISO(iso, n) {
    const d = isoToDate(iso);
    d.setDate(d.getDate() + n);
    return dateToISO(d);
  }
  function formatDateShort(iso) {
    const d = isoToDate(iso);
    return d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
  }
  function monthLabelForDate(iso) {
    const d = isoToDate(iso);
    return d.toLocaleDateString(undefined, { month: "long", year: "numeric" });
  }

  /* -----------------------------------------------------
     Money formatting
  ----------------------------------------------------- */
  function fmtMoney(amount, currency) {
    const n = Number(amount) || 0;
    const isWhole = Math.abs(n - Math.round(n)) < EPS;
    const opts = isWhole
      ? { minimumFractionDigits: 0, maximumFractionDigits: 0 }
      : { minimumFractionDigits: 2, maximumFractionDigits: 2 };
    return `${n.toLocaleString(undefined, opts)} ${currency}`;
  }
  function fmtNum(amount) {
    const n = Number(amount) || 0;
    const isWhole = Math.abs(n - Math.round(n)) < EPS;
    return n.toLocaleString(undefined, {
      minimumFractionDigits: isWhole ? 0 : 2,
      maximumFractionDigits: 2,
    });
  }

  /* -----------------------------------------------------
     Working-day date generation
  ----------------------------------------------------- */
  function generateWorkingDates(startDateISO, weekdaySet, count) {
    const dates = [];
    let cursor = startDateISO;
    let guard = 0;
    const useAll = !weekdaySet || weekdaySet.size === 0;
    while (dates.length < count && guard < 3660) {
      const wd = isoToDate(cursor).getDay();
      if (useAll || weekdaySet.has(wd)) dates.push(cursor);
      cursor = addDaysISO(cursor, 1);
      guard++;
    }
    return dates;
  }

  function rebuildDays(oldDays, newWorkingDays, startDate, weekdaySet) {
    const newDates = generateWorkingDates(startDate, weekdaySet, newWorkingDays);
    const oldByDate = new Map((oldDays || []).map((d) => [d.date, d]));
    return newDates.map((date) => {
      const old = oldByDate.get(date);
      return {
        date,
        actual: old ? old.actual : null,
        actualOrders: old && old.actualOrders !== undefined ? old.actualOrders : null,
        off: old && old.off !== undefined ? old.off : false,
      };
    });
  }

  /* -----------------------------------------------------
     Default state
  ----------------------------------------------------- */
  function makeDefaultMonth(startDate) {
    const start = startDate || todayISO();
    const workingDays = 26;
    const weekdaySet = new Set([1, 2, 3, 4, 5, 6]); // Mon-Sat working, Sun off
    return {
      id: "m_" + Date.now(),
      monthlyTarget: 5000,
      ordersTarget: 450,
      currency: "AED",
      workingDays,
      startDate: start,
      workingWeekdays: Array.from(weekdaySet).sort(),
      days: rebuildDays([], workingDays, start, weekdaySet),
    };
  }

  function freshState() {
    return { version: 1, currentMonth: makeDefaultMonth(), history: [] };
  }

  function normalizeState(parsed) {
    if (!parsed || typeof parsed !== "object") return freshState();
    if (!parsed.currentMonth) parsed.currentMonth = makeDefaultMonth();
    if (!parsed.history) parsed.history = [];
    if (parsed.currentMonth.ordersTarget === undefined) parsed.currentMonth.ordersTarget = 450;
    (parsed.currentMonth.days || []).forEach((d) => {
      if (d.actualOrders === undefined) d.actualOrders = null;
      if (d.off === undefined) d.off = false;
    });
    return parsed;
  }

  /* -----------------------------------------------------
     Firebase (Auth + Firestore)
  ----------------------------------------------------- */
  firebase.initializeApp(window.FIREBASE_CONFIG);
  const auth = firebase.auth();
  const db = firebase.firestore();
  let currentUser = null;
  let saveTimer = null;
  let saving = false;
  let savePending = false;

  function userDoc() {
    return db.collection("users").doc(currentUser.uid);
  }

  async function loadStateFromCloud() {
    const snap = await userDoc().get();
    if (snap.exists && snap.data().state) {
      // Stored as a JSON string so nested arrays/dates round-trip exactly.
      return normalizeState(JSON.parse(snap.data().state));
    }
    const fresh = freshState();
    await userDoc().set({
      state: JSON.stringify(fresh),
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
    return fresh;
  }

  // Debounced: rapid edits collapse into one write; never two writes at once.
  function saveState() {
    if (!currentUser) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flushSave, 400);
  }

  async function flushSave() {
    if (!currentUser) return;
    if (saving) { savePending = true; return; }
    saving = true;
    try {
      await userDoc().set({
        state: JSON.stringify(state),
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      });
    } catch (e) {
      console.error("Failed to save state", e);
      toast("Couldn't save to the cloud — check your connection.");
    } finally {
      saving = false;
      if (savePending) { savePending = false; flushSave(); }
    }
  }

  let state = freshState();
  let todayEditMode = false; // transient — true while the inline "Edit today" form is open

  /* -----------------------------------------------------
     Core calculation engine (rolling redistribution)

     Each unfilled day's target = (target − achieved so far) ÷
     (working days − days completed so far). Recalculated fresh
     every time an actual is saved, so a shortfall or surplus is
     spread evenly across whatever days remain rather than dumped
     onto a single next day.
  ----------------------------------------------------- */
  function computeSeries(monthlyTarget, workingDays, days, actualKey) {
    const base = workingDays > 0 ? monthlyTarget / workingDays : 0;
    let sumActuals = 0;
    let completedCount = 0;
    let offCount = 0;
    const computed = [];

    days.forEach((d, idx) => {
      const isOff = !!d.off;
      const rawActual = d[actualKey];
      const hasActual = !isOff && rawActual !== null && rawActual !== undefined && rawActual !== "";

      const remainingTargetBefore = monthlyTarget - sumActuals;
      const remainingDaysBefore = Math.max(1, workingDays - completedCount - offCount);

      let adjustedTarget;
      let diff = null;
      let status;

      if (isOff) {
        adjustedTarget = 0;
        status = "off";
        offCount += 1;
      } else {
        adjustedTarget = Math.max(0, remainingTargetBefore / remainingDaysBefore);
        if (hasActual) {
          diff = rawActual - adjustedTarget;
          if (diff > EPS) status = "over";
          else if (diff < -EPS) status = "under";
          else status = "completed";
          sumActuals += Number(rawActual);
          completedCount += 1;
        } else {
          status = "pending";
        }
      }

      computed.push({
        index: idx,
        date: d.date,
        actual: hasActual ? rawActual : null,
        off: isOff,
        baseTarget: base,
        carryIn: adjustedTarget - base,
        adjustedTarget,
        diff,
        status,
      });
    });

    const totalAchieved = sumActuals;
    const remaining = Math.max(0, monthlyTarget - totalAchieved);
    const remainingWorkingDays = Math.max(0, workingDays - completedCount - offCount);
    const requiredDailyAvg = remainingWorkingDays > 0 ? remaining / remainingWorkingDays : 0;
    const pct = monthlyTarget > 0 ? (totalAchieved / monthlyTarget) * 100 : 0;
    // Positive = currently need more per day than the flat baseline (behind pace).
    // Negative = need less than baseline (ahead of pace).
    const paceTrend = requiredDailyAvg - base;

    return {
      days: computed,
      base,
      totalAchieved,
      completedCount,
      offCount,
      remaining,
      remainingWorkingDays,
      requiredDailyAvg,
      pct,
      paceTrend,
    };
  }

  function computeMonth(month) {
    const money = computeSeries(month.monthlyTarget, month.workingDays, month.days, "actual");
    const orders = computeSeries(month.ordersTarget || 0, month.workingDays, month.days, "actualOrders");
    const tISO = todayISO();
    const todayIndex = money.days.findIndex((d) => d.date === tISO);
    return { money, orders, todayIndex };
  }

  /* -----------------------------------------------------
     Rendering
  ----------------------------------------------------- */
  const el = (id) => document.getElementById(id);

  function render() {
    const month = state.currentMonth;
    const c = computeMonth(month);
    const cur = month.currency;

    el("monthLabel").textContent = `${monthLabelForDate(month.startDate)} · Monthly target`;
    el("monthlyTargetAmt").textContent = fmtMoney(month.monthlyTarget, cur);
    el("monthlyPct").textContent = `${Math.round(c.money.pct)}%`;
    el("monthlyBarFill").style.width = `${Math.min(100, c.money.pct)}%`;
    el("statAchieved").textContent = fmtMoney(c.money.totalAchieved, cur);
    el("statRemaining").textContent = fmtMoney(c.money.remaining, cur);
    el("statDays").textContent = `${c.money.completedCount} / ${month.workingDays}` + (c.money.offCount > 0 ? ` (${c.money.offCount} off)` : "");
    el("statRequiredAvg").textContent = fmtMoney(c.money.requiredDailyAvg, cur);
    el("statRequiredOrdersAvg").textContent = fmtNum(c.orders.requiredDailyAvg);
    renderTrend("trendAed", c.money.paceTrend);
    renderTrend("trendOrders", c.orders.paceTrend);
    el("statDaysLeft").textContent = `${c.money.remainingWorkingDays}`;
    el("entryCurrency").textContent = cur;

    el("ordersPct").textContent = `${Math.round(c.orders.pct)}%`;
    el("ordersBarFill").style.width = `${Math.min(100, c.orders.pct)}%`;
    el("ordersNums").textContent = `${fmtNum(c.orders.totalAchieved)} / ${fmtNum(month.ordersTarget || 0)} orders`;

    renderProjection("heroProjection", c.money, month.monthlyTarget, (v) => fmtMoney(v, cur));
    renderProjection("ordersProjection", c.orders, month.ordersTarget || 0, (v) => `${fmtNum(v)} orders`);

    renderWelcomeBanner();
    renderTrendChart(c);
    renderToday(month, c);
    renderRecentStrip(month, c);
  }

  function renderWelcomeBanner() {
    const now = new Date();
    const hour = now.getHours();
    const greeting = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
    el("welcomeGreeting").textContent = greeting;
    el("welcomeDate").textContent = now.toLocaleDateString(undefined, {
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric",
    });
  }

  function renderTrendChart(c) {
    const wrap = el("trendChartWrap");
    if (!wrap) return;
    const pts = c.money.days.filter((d) => d.actual !== null);
    if (pts.length < 2) {
      wrap.innerHTML = `<div class="trend-empty">Log at least 2 days to see your trend line.</div>`;
      return;
    }

    const w = 320,
      h = 110,
      padL = 6,
      padR = 6,
      padT = 10,
      padB = 8;
    const allVals = pts.map((d) => d.actual).concat(pts.map((d) => d.adjustedTarget));
    const maxVal = Math.max(...allVals) * 1.15 || 1;
    const xStep = (w - padL - padR) / Math.max(1, pts.length - 1);
    const xFor = (i) => padL + i * xStep;
    const yFor = (v) => h - padB - (v / maxVal) * (h - padT - padB);

    const actualPts = pts.map((d, i) => `${xFor(i).toFixed(1)},${yFor(d.actual).toFixed(1)}`).join(" ");
    const targetPts = pts.map((d, i) => `${xFor(i).toFixed(1)},${yFor(d.adjustedTarget).toFixed(1)}`).join(" ");
    const areaPts = `${xFor(0).toFixed(1)},${(h - padB).toFixed(1)} ${actualPts} ${xFor(pts.length - 1).toFixed(1)},${(h - padB).toFixed(1)}`;
    const dots = pts
      .map(
        (d, i) =>
          `<circle cx="${xFor(i).toFixed(1)}" cy="${yFor(d.actual).toFixed(1)}" r="2.6" style="fill:var(--accent)" />`
      )
      .join("");

    wrap.innerHTML = `
      <svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}" preserveAspectRatio="none">
        <polygon points="${areaPts}" style="fill:var(--accent-soft);stroke:none" />
        <polyline points="${targetPts}" style="fill:none;stroke:var(--ink-faint);stroke-width:1.4;stroke-dasharray:3,3" />
        <polyline points="${actualPts}" style="fill:none;stroke:var(--accent);stroke-width:2.2" stroke-linejoin="round" stroke-linecap="round" />
        ${dots}
      </svg>
      <div class="trend-legend">
        <span><i class="trend-swatch actual"></i>Achieved</span>
        <span><i class="trend-swatch target"></i>Target that day</span>
      </div>
    `;
  }

  function renderProjection(id, series, target, fmt) {
    const node = el(id);
    if (!node) return;
    if (series.completedCount === 0) {
      node.className = "hero-projection muted";
      node.textContent = "Log a day to see your projected total at this pace.";
      return;
    }
    const perDayPace = series.totalAchieved / series.completedCount;
    const projected = perDayPace * series.days.length;
    const delta = projected - target;
    const sign = delta >= 0 ? "+" : "";
    node.className = "hero-projection " + (delta >= 0 ? "pos" : "neg");
    node.textContent = `Projected at this pace: ${fmt(projected)} (${sign}${fmt(delta)} vs target)`;
  }

  function progressBarColor(pct) {
    if (pct < 30) return "var(--red)";
    if (pct < 70) return "var(--amber)";
    return "var(--accent)";
  }

  function renderTrend(id, trend) {
    const node = el(id);
    if (!node) return;
    const pctBase = Math.abs(trend) < EPS ? 0 : trend;
    if (Math.abs(pctBase) < EPS) {
      node.className = "trend-arrow flat";
      node.textContent = "—";
      node.title = "On pace with the flat baseline";
    } else if (pctBase > 0) {
      node.className = "trend-arrow up";
      node.textContent = "▲";
      node.title = "Behind pace — needs more per day than baseline";
    } else {
      node.className = "trend-arrow down";
      node.textContent = "▼";
      node.title = "Ahead of pace — needs less per day than baseline";
    }
  }

  function renderToday(month, c) {
    const cur = month.currency;
    const input = el("todayInput");
    const ordersInput = el("todayOrdersInput");
    const btn = el("btnSaveToday");
    const fields = el("entryFields");
    const summary = el("todayLoggedSummary");
    const offBanner = el("todayOffBanner");
    const workingContent = el("todayWorkingContent");

    if (c.todayIndex === -1) {
      offBanner.classList.add("hidden");
      workingContent.classList.remove("hidden");
      el("todayTarget").textContent = "—";
      el("todayOrdersTarget").textContent = "—";
      setPill("todayStatus", "pending", "No active day");
      setPill("todayOrdersStatus", "pending", "No active day");
      const msg =
        todayISO() < month.startDate
          ? "This month's tracking hasn't started yet."
          : "Today isn't a working day, or the month is complete.";
      el("todayCarryNote").textContent = msg;
      el("todayOrdersCarryNote").textContent = msg;
      el("todayBarFill").style.width = "0%";
      el("todayOrdersBarFill").style.width = "0%";
      fields.classList.remove("hidden");
      summary.classList.add("hidden");
      btn.textContent = "Save today's result";
      btn.dataset.mode = "save";
      input.disabled = true;
      ordersInput.disabled = true;
      input.value = "";
      ordersInput.value = "";
      btn.disabled = true;
      btn.style.opacity = 0.5;
      return;
    }

    const moneyDay = c.money.days[c.todayIndex];

    if (moneyDay.off) {
      offBanner.classList.remove("hidden");
      workingContent.classList.add("hidden");
      return;
    }
    offBanner.classList.add("hidden");
    workingContent.classList.remove("hidden");

    input.disabled = false;
    ordersInput.disabled = false;
    btn.disabled = false;
    btn.style.opacity = 1;

    const orderDay = c.orders.days[c.todayIndex];
    const isLogged = moneyDay.actual !== null;
    const showForm = !isLogged || todayEditMode;

    renderTodayMetric(moneyDay, cur, {
      targetEl: "todayTarget",
      pillEl: "todayStatus",
      noteEl: "todayCarryNote",
      barEl: "todayBarFill",
      barClass: "accent2",
      formatVal: (v) => fmtMoney(v, cur),
    });
    input.value = moneyDay.actual !== null ? moneyDay.actual : "";

    renderTodayMetric(orderDay, "orders", {
      targetEl: "todayOrdersTarget",
      pillEl: "todayOrdersStatus",
      noteEl: "todayOrdersCarryNote",
      barEl: "todayOrdersBarFill",
      barClass: "accent-orders",
      formatVal: (v) => `${fmtNum(v)} orders`,
    });
    ordersInput.value = orderDay.actual !== null ? orderDay.actual : "";

    fields.classList.toggle("hidden", !showForm);
    if (showForm) {
      summary.classList.add("hidden");
      btn.textContent = "Save today's result";
      btn.dataset.mode = "save";
    } else {
      summary.classList.remove("hidden");
      el("todayLoggedText").textContent = `Logged for today: ${fmtMoney(moneyDay.actual, cur)} · ${
        orderDay.actual !== null ? fmtNum(orderDay.actual) : "0"
      } orders`;
      btn.textContent = "Edit today's result";
      btn.dataset.mode = "edit";
    }
  }

  function renderTodayMetric(day, cur, opts) {
    const achieved = day.actual !== null ? fmtNum(day.actual) : "—";
    el(opts.targetEl).innerHTML = `${achieved} <span class="today-amount-target">/ ${opts.formatVal(day.adjustedTarget)}</span>`;

    const pct = day.adjustedTarget > 0 ? Math.round(((day.actual || 0) / day.adjustedTarget) * 100) : 0;
    setPill(opts.pillEl, day.status, `${pct}% · ${statusLabel(day.status)}`);

    if (Math.abs(day.carryIn) > EPS) {
      const word = day.carryIn > 0 ? "carried forward from a shortfall" : "reduced by a previous surplus";
      el(opts.noteEl).textContent = `Base target ${opts.formatVal(day.baseTarget)}, ${word} (${opts.formatVal(
        Math.abs(day.carryIn)
      )}).`;
    } else {
      el(opts.noteEl).textContent = `Base daily target — no carry-forward adjustment.`;
    }

    const fill = el(opts.barEl);
    fill.style.width = `${Math.min(100, pct)}%`;
    fill.className = "bar-fill";
    fill.style.background = progressBarColor(pct);
  }

  function setPill(id, status, text) {
    const pill = el(id);
    pill.className = "status-pill " + status;
    pill.textContent = text;
  }

  function statusLabel(status) {
    return { pending: "Pending", over: "Over Target", under: "Under Target", completed: "Completed", off: "Off" }[status];
  }

  function renderRecentStrip(month, c) {
    const strip = el("recentStrip");
    strip.innerHTML = "";
    const moneyDays = c.money.days;
    const ordersDays = c.orders.days;
    if (moneyDays.length === 0) return;

    const cur = month.currency;
    const tISO = todayISO();

    // Anchor around today if it's within the tracked days, otherwise the
    // most recently logged day, otherwise just the start of the month.
    let anchor = c.todayIndex !== -1 ? c.todayIndex : -1;
    if (anchor === -1) {
      for (let i = moneyDays.length - 1; i >= 0; i-