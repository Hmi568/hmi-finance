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
      for (let i = moneyDays.length - 1; i >= 0; i--) {
        if (moneyDays[i].actual !== null) {
          anchor = i;
          break;
        }
      }
    }
    if (anchor === -1) anchor = 0;

    const start = Math.max(0, anchor - 2);
    const indices = [];
    for (let i = anchor; i >= start; i--) indices.push(i); // most recent first, 3 rows

    if (indices.length === 0) {
      strip.innerHTML = `<div class="recent-empty">No days yet — pick a date under "All days" to get started.</div>`;
      return;
    }

    indices.forEach((i) => {
      const day = moneyDays[i];
      const orderDay = ordersDays[i];
      const item = document.createElement("div");
      item.className = "rs-item " + day.status + (day.date === tISO ? " is-today" : "");

      if (day.off) {
        item.innerHTML = `
          <div class="rs-accent"></div>
          <div class="rs-body">
            <div class="rs-top"><span>Day ${day.index + 1} · ${formatDateShort(day.date)}</span><span>Off</span></div>
            <div class="rs-mid"><span class="rs-amount">Day off</span></div>
          </div>
        `;
        item.addEventListener("click", () => openEditDay(day.index));
        strip.appendChild(item);
        return;
      }

      const pct = day.adjustedTarget > 0 ? ((day.actual || 0) / day.adjustedTarget) * 100 : 0;
      item.innerHTML = `
        <div class="rs-accent"></div>
        <div class="rs-body">
          <div class="rs-top"><span>Day ${day.index + 1} · ${formatDateShort(day.date)}</span><span>${statusLabel(
        day.status
      )}</span></div>
          <div class="rs-mid">
            <span class="rs-amount">${day.actual !== null ? fmtMoney(day.actual, cur) : "—"} / ${fmtMoney(
        day.adjustedTarget,
        cur
      )}</span>
            <span class="rs-orders">${orderDay.actual !== null ? fmtNum(orderDay.actual) : "—"} / ${fmtNum(
        orderDay.adjustedTarget
      )} orders</span>
          </div>
          <div class="rs-bar"><div class="rs-bar-fill" style="width:${Math.min(100, pct)}%; background:${progressBarColor(
        pct
      )}"></div></div>
        </div>
      `;
      item.addEventListener("click", () => openEditDay(day.index));
      strip.appendChild(item);
    });
  }

  /* -----------------------------------------------------
     Today entry
  ----------------------------------------------------- */
  el("btnSaveToday").addEventListener("click", () => {
    const c = computeMonth(state.currentMonth);
    if (c.todayIndex === -1) return;

    if (el("btnSaveToday").dataset.mode === "edit") {
      todayEditMode = true;
      render();
      return;
    }

    const val = el("todayInput").value;
    const ordersVal = el("todayOrdersInput").value;
    state.currentMonth.days[c.todayIndex].actual = val === "" ? null : Math.max(0, Number(val));
    state.currentMonth.days[c.todayIndex].actualOrders = ordersVal === "" ? null : Math.max(0, Math.round(Number(ordersVal)));
    todayEditMode = false;
    saveState();
    render();
    toast("Today's result saved.");
  });

  el("btnMarkOff").addEventListener("click", () => {
    const c = computeMonth(state.currentMonth);
    if (c.todayIndex === -1) return;
    state.currentMonth.days[c.todayIndex].off = true;
    state.currentMonth.days[c.todayIndex].actual = null;
    state.currentMonth.days[c.todayIndex].actualOrders = null;
    todayEditMode = false;
    saveState();
    render();
    toast("Today marked as off.");
  });

  el("btnUnmarkOff").addEventListener("click", () => {
    const c = computeMonth(state.currentMonth);
    if (c.todayIndex === -1) return;
    state.currentMonth.days[c.todayIndex].off = false;
    saveState();
    render();
    toast("Today is back to working.");
  });

  /* -----------------------------------------------------
     Edit day modal
  ----------------------------------------------------- */
  let editingIndex = null;

  function openEditDay(index) {
    const month = state.currentMonth;
    const c = computeMonth(month);
    const day = c.money.days[index];
    const orderDay = c.orders.days[index];
    editingIndex = index;

    el("editDayTitle").textContent = `Day ${index + 1} · ${formatDateShort(day.date)}`;
    el("editDayTargetInfo").textContent = `Target: ${fmtMoney(day.adjustedTarget, month.currency)} (base ${fmtMoney(
      day.baseTarget,
      month.currency
    )}) · ${fmtNum(orderDay.adjustedTarget)} orders (base ${fmtNum(orderDay.baseTarget)})`;
    el("editDayInput").value = day.actual !== null ? day.actual : "";
    el("editDayOrdersInput").value = orderDay.actual !== null ? orderDay.actual : "";
    el("editDayOffToggle").checked = !!day.off;
    toggleEditDayOffUI(!!day.off);
    openModal("editDayModal");
  }

  function toggleEditDayOffUI(isOff) {
    el("editDayFieldAed").classList.toggle("hidden", isOff);
    el("editDayFieldOrders").classList.toggle("hidden", isOff);
  }
  el("editDayOffToggle").addEventListener("change", (e) => toggleEditDayOffUI(e.target.checked));

  el("btnCloseEditDay").addEventListener("click", () => closeModal("editDayModal"));
  el("btnSaveDay").addEventListener("click", () => {
    if (editingIndex === null) return;
    const isOff = el("editDayOffToggle").checked;
    const day = state.currentMonth.days[editingIndex];
    day.off = isOff;
    if (isOff) {
      day.actual = null;
      day.actualOrders = null;
    } else {
      const val = el("editDayInput").value;
      const ordersVal = el("editDayOrdersInput").value;
      day.actual = val === "" ? null : Math.max(0, Number(val));
      day.actualOrders = ordersVal === "" ? null : Math.max(0, Math.round(Number(ordersVal)));
    }
    saveState();
    closeModal("editDayModal");
    render();
    toast(isOff ? "Day marked as off." : "Day updated.");
  });
  el("btnClearDay").addEventListener("click", () => {
    if (editingIndex === null) return;
    state.currentMonth.days[editingIndex].actual = null;
    state.currentMonth.days[editingIndex].actualOrders = null;
    state.currentMonth.days[editingIndex].off = false;
    saveState();
    closeModal("editDayModal");
    render();
    toast("Entry cleared.");
  });

  /* -----------------------------------------------------
     Calendar (All days)
  ----------------------------------------------------- */
  let calCursor = null; // { year, month } — month is 0-indexed

  function openCalendar() {
    const tISO = todayISO();
    const anchorDate = calCursor ? null : isoToDate(tISO);
    if (!calCursor) {
      calCursor = { year: anchorDate.getFullYear(), month: anchorDate.getMonth() };
    }
    renderCalendar();
    openModal("calendarModal");
  }

  function renderCalendar() {
    const month = state.currentMonth;
    const dateIndex = new Map(month.days.map((d, i) => [d.date, i]));
    const tISO = todayISO();

    const { year, month: m } = calCursor;
    const label = new Date(year, m, 1).toLocaleDateString(undefined, { month: "long", year: "numeric" });
    el("calMonthLabel").textContent = label;

    const firstWeekday = new Date(year, m, 1).getDay();
    const totalDays = new Date(year, m + 1, 0).getDate();

    const grid = el("calGrid");
    grid.innerHTML = "";

    for (let i = 0; i < firstWeekday; i++) {
      const blank = document.createElement("div");
      blank.className = "cal-cell blank";
      grid.appendChild(blank);
    }

    for (let day = 1; day <= totalDays; day++) {
      const iso = `${year}-${String(m + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      const idx = dateIndex.has(iso) ? dateIndex.get(iso) : null;
      const isWorking = idx !== null;
      const dayData = isWorking ? month.days[idx] : null;
      const isOff = isWorking && !!dayData.off;
      const isLogged = isWorking && !isOff && dayData.actual !== null && dayData.actual !== undefined;
      const isToday = iso === tISO;

      const cell = document.createElement("button");
      cell.type = "button";
      cell.className =
        "cal-cell " +
        (isWorking ? "working" : "disabled") +
        (isOff ? " off-day" : "") +
        (isLogged ? " logged" : "") +
        (isToday ? " today" : "");
      cell.innerHTML = `<span>${day}</span>${isLogged ? '<i class="cal-check">✅</i>' : ""}`;

      if (isWorking) {
        cell.addEventListener("click", () => {
          closeModal("calendarModal");
          openEditDay(idx);
        });
      } else {
        cell.disabled = true;
      }
      grid.appendChild(cell);
    }
  }

  el("btnAllDays").addEventListener("click", openCalendar);
  el("btnCloseCalendar").addEventListener("click", () => closeModal("calendarModal"));
  el("btnCalPrev").addEventListener("click", () => {
    calCursor.month -= 1;
    if (calCursor.month < 0) {
      calCursor.month = 11;
      calCursor.year -= 1;
    }
    renderCalendar();
  });
  el("btnCalNext").addEventListener("click", () => {
    calCursor.month += 1;
    if (calCursor.month > 11) {
      calCursor.month = 0;
      calCursor.year += 1;
    }
    renderCalendar();
  });

  /* -----------------------------------------------------
     Settings modal
  ----------------------------------------------------- */
  function openSettings() {
    const m = state.currentMonth;
    el("inTarget").value = m.monthlyTarget;
    el("inOrdersTarget").value = m.ordersTarget || 0;
    el("inCurrency").value = m.currency;
    el("inWorkingDays").value = m.workingDays;
    el("inStartDate").value = m.startDate;
    const set = new Set(m.workingWeekdays);
    document.querySelectorAll("#weekdayPicker .wd").forEach((btn) => {
      const d = Number(btn.dataset.d);
      btn.classList.toggle("active", set.has(d));
    });
    openModal("settingsModal");
  }

  document.querySelectorAll("#weekdayPicker .wd").forEach((btn) => {
    btn.addEventListener("click", () => btn.classList.toggle("active"));
  });

  el("btnSettings").addEventListener("click", openSettings);
  el("btnCloseSettings").addEventListener("click", () => closeModal("settingsModal"));

  el("btnSaveSettings").addEventListener("click", () => {
    const target = Math.max(0, Number(el("inTarget").value) || 0);
    const ordersTarget = Math.max(0, Math.round(Number(el("inOrdersTarget").value) || 0));
    const currency = (el("inCurrency").value || "AED").trim().slice(0, 6) || "AED";
    const workingDays = Math.max(1, Math.round(Number(el("inWorkingDays").value) || 1));
    const startDate = el("inStartDate").value || todayISO();
    const weekdaySet = new Set(
      Array.from(document.querySelectorAll("#weekdayPicker .wd.active")).map((b) => Number(b.dataset.d))
    );

    const m = state.currentMonth;
    m.monthlyTarget = target;
    m.ordersTarget = ordersTarget;
    m.currency = currency;
    m.days = rebuildDays(m.days, workingDays, startDate, weekdaySet);
    m.workingDays = workingDays;
    m.startDate = startDate;
    m.workingWeekdays = Array.from(weekdaySet).sort();
    todayEditMode = false;

    saveState();
    closeModal("settingsModal");
    render();
    toast("Settings saved.");
  });

  /* -----------------------------------------------------
     Clear month / New month
  ----------------------------------------------------- */
  el("btnClearMonth").addEventListener("click", () => {
    confirmAction(
      "Are you sure you want to clear this month's data? This action cannot be undone.",
      "Clear month",
      () => {
        state.currentMonth.days = state.currentMonth.days.map((d) => ({ date: d.date, actual: null, actualOrders: null }));
        todayEditMode = false;
        saveState();
        render();
        toast("Month cleared.");
      }
    );
  });

  el("btnNewMonth").addEventListener("click", () => {
    confirmAction(
      "Start a new month? The current month will be saved to History and a fresh tracker will begin.",
      "Start new month",
      () => {
        archiveCurrentMonth();
        const next = makeDefaultMonth(todayISO());
        // carry forward the same settings as a convenience
        next.monthlyTarget = state.currentMonth ? next.monthlyTarget : 5000;
        state.currentMonth = next;
        todayEditMode = false;
        saveState();
        render();
        toast("New month started.");
      }
    );
  });

  function archiveCurrentMonth() {
    const m = state.currentMonth;
    const c = computeMonth(m);
    state.history.unshift({
      id: m.id,
      monthLabel: monthLabelForDate(m.startDate),
      currency: m.currency,
      target: m.monthlyTarget,
      achieved: c.money.totalAchieved,
      percent: Math.round(c.money.pct),
      ordersTarget: m.ordersTarget || 0,
      ordersAchieved: c.orders.totalAchieved,
      ordersPercent: Math.round(c.orders.pct),
      workingDays: m.workingDays,
      completedDays: c.money.completedCount,
      status: c.money.pct >= 100 ? "Completed" : "Incomplete",
      days: c.money.days.map((d, i) => ({
        date: d.date,
        actual: d.actual,
        adjustedTarget: d.adjustedTarget,
        actualOrders: c.orders.days[i].actual,
        ordersAdjustedTarget: c.orders.days[i].adjustedTarget,
      })),
    });
  }

  /* -----------------------------------------------------
     History view
  ----------------------------------------------------- */
  el("btnHistory").addEventListener("click", () => {
    renderHistory();
    el("historyView").classList.remove("hidden");
  });
  el("btnBackFromHistory").addEventListener("click", () => {
    el("historyView").classList.add("hidden");
  });

  function renderHistory() {
    const wrap = el("historyList");
    wrap.innerHTML = "";
    if (state.history.length === 0) {
      wrap.innerHTML = `<div class="empty-state">No past months yet.<br>Start a new month to build your history.</div>`;
      return;
    }
    state.history.forEach((h) => {
      const item = document.createElement("div");
      item.className = "history-item";
      item.innerHTML = `
        <div class="history-item-top">
          <div class="history-month">${h.monthLabel}</div>
          <div class="history-pct">${h.percent}%</div>
        </div>
        <div class="history-sub">${fmtMoney(h.achieved, h.currency)} of ${fmtMoney(h.target, h.currency)} · ${
        h.completedDays
      }/${h.workingDays} days · ${h.status}</div>
        <div class="history-sub">${fmtNum(h.ordersAchieved || 0)} of ${fmtNum(h.ordersTarget || 0)} orders (${
        h.ordersPercent || 0
      }%)</div>
        <div class="history-days">
          ${h.days
            .map(
              (d) =>
                `<div class="history-day-row"><span>${formatDateShort(d.date)}</span><span>${
                  d.actual === null ? "—" : fmtMoney(d.actual, h.currency)
                } / ${fmtMoney(d.adjustedTarget, h.currency)}</span></div>`
            )
            .join("")}
        </div>
      `;
      item.addEventListener("click", () => item.classList.toggle("open"));
      wrap.appendChild(item);
    });
  }

  /* -----------------------------------------------------
     Generic confirm modal
  ----------------------------------------------------- */
  let confirmCallback = null;
  function confirmAction(text, okLabel, cb) {
    el("confirmText").textContent = text;
    el("btnConfirmOk").textContent = okLabel || "Confirm";
    confirmCallback = cb;
    openModal("confirmModal");
  }
  el("btnConfirmCancel").addEventListener("click", () => closeModal("confirmModal"));
  el("btnConfirmOk").addEventListener("click", () => {
    const cb = confirmCallback;
    confirmCallback = null;
    closeModal("confirmModal");
    if (cb) cb();
  });

  /* -----------------------------------------------------
     Modal helpers
  ----------------------------------------------------- */
  function openModal(id) {
    el(id).classList.remove("hidden");
  }
  function closeModal(id) {
    el(id).classList.add("hidden");
  }
  document.querySelectorAll(".modal-backdrop").forEach((backdrop) => {
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) backdrop.classList.add("hidden");
    });
  });

  /* -----------------------------------------------------
     Toast
  ----------------------------------------------------- */
  let toastTimer = null;
  function toast(msg) {
    const t = el("toast");
    t.textContent = msg;
    t.classList.remove("hidden");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.add("hidden"), 2200);
  }

  /* -----------------------------------------------------
     Init
  ----------------------------------------------------- */
  /* -----------------------------------------------------
     Auth UI
  ----------------------------------------------------- */
  const authOverlay = el("authOverlay");
  const authError = el("authError");
  let authMode = "signin"; // or "signup"

  function setAuthMode(mode) {
    authMode = mode;
    el("authTitle").textContent = mode === "signin" ? "Sign in" : "Create account";
    el("authSubmit").textContent = mode === "signin" ? "Sign in" : "Create account";
    el("authToggleText").textContent = mode === "signin" ? "No account yet?" : "Already have an account?";
    el("authToggle").textContent = mode === "signin" ? "Create one" : "Sign in";
    el("authForgot").classList.toggle("hidden", mode !== "signin");
    el("authPassword").autocomplete = mode === "signin" ? "current-password" : "new-password";
    authError.textContent = "";
  }

  function friendlyAuthError(e) {
    const map = {
      "auth/invalid-email": "That email address isn't valid.",
      "auth/user-not-found": "Wrong email or password.",
      "auth/wrong-password": "Wrong email or password.",
      "auth/invalid-credential": "Wrong email or password.",
      "auth/invalid-login-credentials": "Wrong email or password.",
      "auth/email-already-in-use": "An account with this email already exists.",
      "auth/weak-password": "Password must be at least 6 characters.",
      "auth/too-many-requests": "Too many attempts. Try again in a few minutes.",
      "auth/network-request-failed": "Network error. Check your connection.",
      "auth/popup-closed-by-user": "Sign-in was cancelled.",
      "auth/unauthorized-domain": "This domain isn't authorized in Firebase (Authentication → Settings → Authorized domains).",
    };
    return map[e.code] || "Something went wrong. Please try again.";
  }

  el("authForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    authError.textContent = "";
    const email = el("authEmail").value.trim();
    const password = el("authPassword").value;
    el("authSubmit").disabled = true;
    try {
      if (authMode === "signin") await auth.signInWithEmailAndPassword(email, password);
      else await auth.createUserWithEmailAndPassword(email, password);
    } catch (err) {
      authError.textContent = friendlyAuthError(err);
    } finally {
      el("authSubmit").disabled = false;
    }
  });

  el("authToggle").addEventListener("click", () =>
    setAuthMode(authMode === "signin" ? "signup" : "signin"));

  el("authGoogle").addEventListener("click", async () => {
    authError.textContent = "";
    try {
      await auth.signInWithPopup(new firebase.auth.GoogleAuthProvider());
    } catch (err) {
      authError.textContent = friendlyAuthError(err);
    }
  });

  el("authForgot").addEventListener("click", async () => {
    const email = el("authEmail").value.trim();
    if (!email) { authError.textContent = "Enter your email above first."; return; }
    try {
      await auth.sendPasswordResetEmail(email);
      authError.textContent = "";
      toast("Password reset email sent.");
    } catch (err) {
      authError.textContent = friendlyAuthError(err);
    }
  });

  el("btnLogout").addEventListener("click", async () => {
    clearTimeout(saveTimer);
    await flushSave(); // make sure the last edit is in the cloud before leaving
    await auth.signOut();
  });

  /* -----------------------------------------------------
     Init — nothing renders until we know who the user is
  ----------------------------------------------------- */
  auth.onAuthStateChanged(async (user) => {
    if (!user) {
      currentUser = null;
      state = freshState(); // wipe in-memory data of the previous user
      document.body.classList.remove("is-authed");
      authOverlay.classList.remove("hidden");
      el("authPassword").value = "";
      return;
    }
    currentUser = user;
    try {
      state = await loadStateFromCloud();
      render();
      authOverlay.classList.add("hidden");
      document.body.classList.add("is-authed");
    } catch (e) {
      console.error("Failed to load state", e);
      authError.textContent = "Couldn't load your data. Check your connection and Firestore rules, then reload.";
      authOverlay.classList.remove("hidden");
    }
  });

  setAuthMode("signin");
})();
