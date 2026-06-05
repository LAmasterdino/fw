(function () {
  const CONFIG = window.TOURNAMENT_CONFIG || {};

  const DEFAULTS = {
    eventName: "Turnier",
    logoUrl: "",
    data: {
      version: 2,
      updatedAt: null,
      eventName: "Turnier",
      logoUrl: "",
      nextGroup: "",
      lastGroup: "",
      note: "",
      sourceText: "",
      parsedSummary: "",
      groups: []
    }
  };

  const state = {
    token: sessionStorage.getItem("tournament_token") || "",
    sha: null,
    data: null,
    ready: false,
    clockTimer: null,
    refreshTimer: null
  };

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  function escapeHtml(str) {
    return String(str ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function nowString() {
    return new Intl.DateTimeFormat("de-DE", {
      timeStyle: "medium",
      dateStyle: "short"
    }).format(new Date());
  }

  function clockString() {
    return new Intl.DateTimeFormat("de-DE", {
      timeStyle: "medium"
    }).format(new Date());
  }

  function uid() {
    return `g_${Math.random().toString(36).slice(2, 9)}_${Date.now().toString(36)}`;
  }

  function emptyGroup(name = "") {
    return {
      id: uid(),
      name,
      qualified: false,
      placement: "",
      heats: [
        { label: "Lauf 1", time: "" },
        { label: "Lauf 2", time: "" },
        { label: "Lauf 3", time: "" }
      ],
      semifinal: "",
      thirdPlace: "",
      final: ""
    };
  }

  function normalizeName(str) {
    return String(str ?? "").trim().replace(/\s+/g, " ").toLowerCase();
  }

  function normalizeData(data) {
    const base = {
      version: DEFAULTS.data.version,
      updatedAt: DEFAULTS.data.updatedAt,
      eventName: DEFAULTS.data.eventName,
      logoUrl: DEFAULTS.data.logoUrl,
      nextGroup: DEFAULTS.data.nextGroup,
      lastGroup: DEFAULTS.data.lastGroup,
      note: DEFAULTS.data.note,
      sourceText: DEFAULTS.data.sourceText,
      parsedSummary: DEFAULTS.data.parsedSummary,
      groups: []
    };

    const src = data && typeof data === "object" ? data : {};

    base.eventName = src.eventName || DEFAULTS.data.eventName;
    base.logoUrl = src.logoUrl || "";
    base.nextGroup = src.nextGroup || "";
    base.lastGroup = src.lastGroup || "";
    base.note = src.note || "";
    base.sourceText = src.sourceText || "";
    base.parsedSummary = src.parsedSummary || "";
    base.version = src.version || 1;
    base.updatedAt = src.updatedAt || null;

    base.groups = Array.isArray(src.groups)
      ? src.groups.map((g, index) => {
          const group = emptyGroup(g?.name || `Gruppe ${index + 1}`);
          group.id = g?.id || uid();
          group.name = g?.name || group.name;
          group.qualified = Boolean(g?.qualified);
          group.placement = g?.placement ?? "";

          group.heats = Array.isArray(g?.heats) && g.heats.length
            ? g.heats.slice(0, 3).map((h, i) => ({
                label: h?.label || `Lauf ${i + 1}`,
                time: h?.time ?? ""
              }))
            : group.heats;

          while (group.heats.length < 3) {
            group.heats.push({
              label: `Lauf ${group.heats.length + 1}`,
              time: ""
            });
          }

          group.semifinal = g?.semifinal ?? "";
          group.thirdPlace = g?.thirdPlace ?? "";
          group.final = g?.final ?? "";
          return group;
        })
      : [];

    return base;
  }

  function getApiBase() {
    return CONFIG.apiBase || "https://api.github.com";
  }

  function getRepoPath() {
    if (!CONFIG.repoOwner || !CONFIG.repoName || !CONFIG.filePath) {
      return null;
    }
    return {
      owner: CONFIG.repoOwner,
      repo: CONFIG.repoName,
      path: CONFIG.filePath,
      branch: CONFIG.branch || "main"
    };
  }

  function rawDataUrl() {
    if (CONFIG.rawDataUrl) return CONFIG.rawDataUrl;
    const rp = getRepoPath();
    if (!rp) return "";
    return `https://raw.githubusercontent.com/${encodeURIComponent(rp.owner)}/${encodeURIComponent(rp.repo)}/${encodeURIComponent(rp.branch)}/${rp.path.replace(/^\/+/, "")}`;
  }

  function toBase64Utf8(str) {
    return btoa(unescape(encodeURIComponent(str)));
  }

  function fromBase64Utf8(str) {
    return decodeURIComponent(escape(atob(str)));
  }

  async function readDataPublic() {
    const url = rawDataUrl();
    if (!url) {
      return normalizeData(DEFAULTS.data);
    }

    const bust = url.includes("?") ? "&" : "?";
    const res = await fetch(`${url}${bust}v=${Date.now()}`, { cache: "no-store" });

    if (!res.ok) {
      throw new Error(`Konnte Daten nicht laden (${res.status})`);
    }

    return normalizeData(await res.json());
  }

  async function readDataPrivate(token) {
    const rp = getRepoPath();
    if (!rp) throw new Error("Repo-Konfiguration fehlt");

    const url = `${getApiBase()}/repos/${encodeURIComponent(rp.owner)}/${encodeURIComponent(rp.repo)}/contents/${rp.path}?ref=${encodeURIComponent(rp.branch)}`;

    const res = await fetch(url, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`
      }
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Konnte Repo-Datei nicht lesen (${res.status})${text ? ` — ${text}` : ""}`);
    }

    const json = await res.json();
    const content = fromBase64Utf8(json.content.replace(/\n/g, ""));
    const data = JSON.parse(content);

    state.sha = json.sha;
    return normalizeData(data);
  }

  async function saveDataPrivate(token, data) {
    const rp = getRepoPath();
    if (!rp) throw new Error("Repo-Konfiguration fehlt");

    const readUrl = `${getApiBase()}/repos/${encodeURIComponent(rp.owner)}/${encodeURIComponent(rp.repo)}/contents/${rp.path}?ref=${encodeURIComponent(rp.branch)}`;

    const readRes = await fetch(readUrl, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`
      }
    });

    if (!readRes.ok) {
      const text = await readRes.text().catch(() => "");
      throw new Error(`Datei konnte nicht gelesen werden (${readRes.status})${text ? ` — ${text}` : ""}`);
    }

    const currentFile = await readRes.json();

    const url = `${getApiBase()}/repos/${encodeURIComponent(rp.owner)}/${encodeURIComponent(rp.repo)}/contents/${rp.path}`;
    const content = toBase64Utf8(JSON.stringify(data, null, 2));

    const body = {
      message: `Update tournament data ${new Date().toISOString()}`,
      content,
      sha: currentFile.sha,
      branch: rp.branch
    };

    const res = await fetch(url, {
      method: "PUT",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Speichern fehlgeschlagen (${res.status}) ${text}`);
    }

    const json = await res.json();
    state.sha = json.content?.sha || currentFile.sha || state.sha;
    return json;
  }

  function setStatus(msg, type = "info") {
    const el = $("#status");
    if (!el) return;
    el.textContent = msg;
    el.dataset.type = type;
  }

  function renderClock() {
    $$(".js-clock").forEach((el) => {
      el.textContent = clockString();
    });
    $$(".js-now").forEach((el) => {
      el.textContent = nowString();
    });
  }

  function setLoginMessage(msg, type = "info") {
    const loginCard = $("#login-form")?.closest(".card");
    if (!loginCard) return;

    let box = loginCard.querySelector(".js-login-msg");
    if (!box) {
      box = document.createElement("div");
      box.className = "status js-login-msg";
      box.style.marginTop = "12px";
      loginCard.appendChild(box);
    }

    box.textContent = msg;
    box.dataset.type = type;
  }

  function clearLoginMessage() {
    const box = $("#login-form")?.closest(".card")?.querySelector(".js-login-msg");
    if (box) box.remove();
  }

  function findOrCreateGroupByName(data, name) {
    const cleaned = String(name ?? "").trim();
    if (!cleaned) return null;

    let group = data.groups.find((g) => normalizeName(g.name) === normalizeName(cleaned));
    if (!group) {
      group = emptyGroup(cleaned);
      data.groups.push(group);
    }
    return group;
  }

  function assignTimeToGroup(group, time) {
    if (!group) return;
    const target = group.heats.find((h) => !String(h.time || "").trim()) || group.heats[0];
    if (target) target.time = String(time ?? "").trim();
  }

  function parseGermanDateTime(value) {
    const m = String(value ?? "").trim().match(/^(\d{2})\.(\d{2})\.(\d{4})\s+(\d{2}):(\d{2}):(\d{2})$/);
    if (!m) return null;
    const [, dd, mm, yyyy, hh, mi, ss] = m;
    const d = new Date(Number(yyyy), Number(mm) - 1, Number(dd), Number(hh), Number(mi), Number(ss));
    return Number.isNaN(d.getTime()) ? null : d;
  }

  function parseSourceLine(line) {
    const text = String(line ?? "").trim();
    if (!text) return null;

    const head = text.match(/^(\d{2}\.\d{2}\.\d{4}\s+\d{2}:\d{2}:\d{2})\s*\|\s*(.+)$/);
    if (!head) return null;

    const timestampText = head[1];
    const rest = head[2];
    const timestamp = parseGermanDateTime(timestampText);

    const pairs = [];
    const pairRe = /([^:|]+?):\s*([0-9]{1,2}:[0-9]{2}(?:[.,][0-9]{2,3})?)/g;
    let match;

    while ((match = pairRe.exec(rest)) !== null) {
      const name = String(match[1] ?? "").replace(/\s+(vs\.?|gegen)$/i, "").trim();
      const time = String(match[2] ?? "").trim();
      if (name && time) {
        pairs.push({ name, time });
      }
    }

    return {
      timestamp,
      timestampText,
      raw: text,
      pairs
    };
  }

  function applySourceTextToData(rawText) {
    if (!state.data) return { parsed: 0, lines: 0, timestamp: null };

    const lines = String(rawText ?? "")
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);

    if (!lines.length) {
      throw new Error("Bitte mindestens eine Zeile einfügen.");
    }

    let parsedCount = 0;
    let latestTimestamp = null;
    const firstTwoNames = [];

    for (const line of lines) {
      const parsed = parseSourceLine(line);
      if (!parsed) continue;

      parsedCount += 1;
      if (parsed.timestamp && (!latestTimestamp || parsed.timestamp > latestTimestamp)) {
        latestTimestamp = parsed.timestamp;
      }

      for (const pair of parsed.pairs) {
        const group = findOrCreateGroupByName(state.data, pair.name);
        if (!group) continue;

        assignTimeToGroup(group, pair.time);

        if (firstTwoNames.length < 2 && !firstTwoNames.includes(group.name)) {
          firstTwoNames.push(group.name);
        }
      }
    }

    if (firstTwoNames[0]) state.data.lastGroup = firstTwoNames[0];
    if (firstTwoNames[1]) state.data.nextGroup = firstTwoNames[1];

    if (latestTimestamp) {
      state.data.updatedAt = latestTimestamp.toISOString();
    } else {
      state.data.updatedAt = new Date().toISOString();
    }

    state.data.sourceText = rawText;
    state.data.parsedSummary = `${parsedCount} Zeile(n) verarbeitet`;

    return {
      parsed: parsedCount,
      lines: lines.length,
      timestamp: latestTimestamp
    };
  }

  function onFieldChange(e) {
    const el = e.currentTarget || e.target;
    const groupId = el.dataset.group;
    const field = el.dataset.field;
    const group = state.data.groups.find((g) => g.id === groupId);
    if (!group) return;

    if (field === "qualified") {
      group.qualified = el.checked;
      return;
    }

    if (field.startsWith("heats.")) {
      const idx = Number(field.split(".")[1]);
      if (!group.heats[idx]) {
        group.heats[idx] = { label: `Lauf ${idx + 1}`, time: "" };
      }
      group.heats[idx].time = el.value;
      return;
    }

    group[field] = el.value;
  }

  function renderAdmin() {
    const root = $("#admin-root");
    if (!root || !state.data) return;

    const data = state.data;

    const rows = data.groups
      .map((group) => {
        const heatInputs = group.heats
          .map(
            (h, idx) => `
              <td>
                <input class="mini js-field" data-group="${group.id}" data-field="heats.${idx}.time" value="${escapeHtml(h.time ?? "")}" placeholder="Zeit">
              </td>
            `
          )
          .join("");

        return `
          <tr>
            <td><input class="mini js-field" data-group="${group.id}" data-field="name" value="${escapeHtml(group.name)}" placeholder="Gruppenname"></td>
            ${heatInputs}
            <td><input class="mini js-field" data-group="${group.id}" data-field="semifinal" value="${escapeHtml(group.semifinal ?? "")}" placeholder="Halbfinale"></td>
            <td><input class="mini js-field" data-group="${group.id}" data-field="thirdPlace" value="${escapeHtml(group.thirdPlace ?? "")}" placeholder="Platz 3"></td>
            <td><input class="mini js-field" data-group="${group.id}" data-field="final" value="${escapeHtml(group.final ?? "")}" placeholder="Finale"></td>
            <td><input class="mini js-field" data-group="${group.id}" data-field="placement" value="${escapeHtml(group.placement ?? "")}" placeholder="Platz"></td>
            <td>
              <label class="row" style="gap:8px;align-items:center">
                <input type="checkbox" class="js-field" data-group="${group.id}" data-field="qualified" ${group.qualified ? "checked" : ""}>
                <span>HF</span>
              </label>
            </td>
            <td><button class="btn btn-danger btn-small js-remove-group" data-group="${group.id}">-</button></td>
          </tr>
        `;
      })
      .join("");

    root.innerHTML = `
      <div class="grid admin">
        <section class="card" style="grid-column:1/-1">
          <div class="spread">
            <div>
              <h3>Rohtext Import</h3>
              <div class="muted small">Format: <strong>01.01.2026 20:20:20 | Test: 00:27.42 vs. Test 1: 00:25.91</strong></div>
            </div>
            <div class="pill">Automatisches Auslesen</div>
          </div>

          <textarea
            id="sourceText"
            style="width:100%;min-height:120px;margin-top:12px;border:1px solid rgba(221,13,27,.22);border-radius:14px;padding:12px;font:inherit;resize:vertical;box-sizing:border-box"
            placeholder="01.01.2026 20:20:20 | Test: 00:27.42 vs. Test 1: 00:25.91"
          >${escapeHtml(data.sourceText || "")}</textarea>

          <div class="row" style="margin-top:12px;justify-content:space-between;align-items:center">
            <div class="muted small">Die Seite zieht daraus Datum, letzte Gruppe, nächste Gruppe und Gruppenzeiten.</div>
            <div class="row">
              <button class="btn btn-soft js-parse-source" type="button">Text übernehmen</button>
              <button class="btn btn-primary js-save" type="button">Speichern</button>
            </div>
          </div>

          <div class="muted small" style="margin-top:10px">
            Ausgelesen: <strong>${escapeHtml(data.parsedSummary || "—")}</strong>
            · Letzte Gruppe: <strong>${escapeHtml(data.lastGroup || "—")}</strong>
            · Nächste Gruppe: <strong>${escapeHtml(data.nextGroup || "—")}</strong>
          </div>
        </section>

        <section class="card">
          <div class="spread">
            <div>
              <h3>Turniersteuerung</h3>
              <div class="muted small">Datenstand: <span class="js-now"></span></div>
            </div>
            <div class="row">
              <button class="btn btn-soft js-add-group" type="button">+ Gruppe hinzufügen</button>
              <button class="btn btn-primary js-save" type="button">Speichern</button>
            </div>
          </div>
          <hr class="sep">
          <div class="stack">
            <input type="text" id="eventName" value="${escapeHtml(data.eventName)}" placeholder="Turniername">
            <input type="url" id="logoUrl" value="${escapeHtml(data.logoUrl || CONFIG.logoUrl || "")}" placeholder="Logo-URL für Client">
            <div class="row">
              <input type="text" id="nextGroup" value="${escapeHtml(data.nextGroup)}" placeholder="Nächste Gruppe">
              <input type="text" id="lastGroup" value="${escapeHtml(data.lastGroup)}" placeholder="Letzte Gruppe">
            </div>
            <textarea
              id="note"
              style="width:100%;min-height:90px;border:1px solid rgba(221,13,27,.22);border-radius:14px;padding:12px;font:inherit;resize:vertical;box-sizing:border-box"
              placeholder="Hinweis für Live/Client"
            >${escapeHtml(data.note || "")}</textarea>
          </div>
          <div class="hint" style="margin-top:14px">
            Die Reihenfolge der Läufe wird hier manuell gepflegt.
          </div>
        </section>

        <section class="card">
          <h3>Login & Status</h3>
          <div class="stack">
            <div class="pill">GitHub Pages + separates Daten-Repo</div>
            <div class="muted">Token gespeichert: <strong>${state.token ? "ja" : "nein"}</strong></div>
            <div class="muted">Zuletzt geladen: <strong>${data.updatedAt ? escapeHtml(new Intl.DateTimeFormat("de-DE", { dateStyle: "short", timeStyle: "medium" }).format(new Date(data.updatedAt))) : "—"}</strong></div>
            <button class="btn btn-ghost js-logout" type="button">Token löschen</button>
          </div>
        </section>

        <section class="card" style="grid-column:1/-1">
          <div class="spread">
            <h3>Gruppen und Zeiten</h3>
            <div class="muted small">3 Läufe für alle, danach Halbfinale / Platz 3 / Finale</div>
          </div>
          <div class="table-wrap" style="margin-top:12px">
            <table>
              <thead>
                <tr>
                  <th>Gruppe</th>
                  <th>Lauf 1</th>
                  <th>Lauf 2</th>
                  <th>Lauf 3</th>
                  <th>Halbfinale</th>
                  <th>Platz 3</th>
                  <th>Finale</th>
                  <th>Platzierung</th>
                  <th>HF</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                ${rows || `<tr><td colspan="10" class="muted">Noch keine Gruppen angelegt.</td></tr>`}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    `;

    $("#eventName")?.addEventListener("input", (e) => (data.eventName = e.target.value));
    $("#logoUrl")?.addEventListener("input", (e) => (data.logoUrl = e.target.value));
    $("#nextGroup")?.addEventListener("input", (e) => (data.nextGroup = e.target.value));
    $("#lastGroup")?.addEventListener("input", (e) => (data.lastGroup = e.target.value));
    $("#note")?.addEventListener("input", (e) => (data.note = e.target.value));
    $("#sourceText")?.addEventListener("input", (e) => {
      data.sourceText = e.target.value;
    });

    $$(".js-field").forEach((el) => {
      if (el.type === "checkbox") {
        el.addEventListener("change", onFieldChange);
      } else {
        el.addEventListener("input", onFieldChange);
      }
    });

    $$(".js-remove-group").forEach((btn) =>
      btn.addEventListener("click", () => {
        data.groups = data.groups.filter((g) => g.id !== btn.dataset.group);
        renderAdmin();
        setStatus("Gruppe entfernt. Bitte speichern.");
      })
    );

    $(".js-add-group")?.addEventListener("click", () => {
      data.groups.push(emptyGroup(`Gruppe ${data.groups.length + 1}`));
      renderAdmin();
      setStatus("Neue Gruppe hinzugefügt. Bitte speichern.");
    });

    $(".js-save")?.addEventListener("click", saveCurrentState);

    $(".js-logout")?.addEventListener("click", () => {
      sessionStorage.removeItem("tournament_token");
      state.token = "";
      state.sha = null;
      clearLoginMessage();
      setStatus("Token gelöscht.");
      updateLoginState();
    });

    $(".js-parse-source")?.addEventListener("click", () => {
      try {
        const rawText = $("#sourceText")?.value || "";
        const result = applySourceTextToData(rawText);
        renderAdmin();
        setStatus(`Text übernommen: ${result.parsed} Zeile(n) verarbeitet.`);
      } catch (err) {
        console.error(err);
        alert(err.message || "Text konnte nicht verarbeitet werden");
        setStatus(err.message || "Text konnte nicht verarbeitet werden", "error");
      }
    });
  }

  function renderClient() {
    const root = $("#client-root");
    if (!root || !state.data) return;

    const data = state.data;
    const logo = data.logoUrl || CONFIG.logoUrl || "";

    const groupsHtml = data.groups
      .map(
        (g) => `
          <div class="list-item">
            <div class="name">${escapeHtml(g.name)}</div>
            <div class="value">${escapeHtml([g.heats?.[0]?.time, g.heats?.[1]?.time, g.heats?.[2]?.time].filter(Boolean).join(" | ") || "—")}</div>
          </div>
        `
      )
      .join("");

    root.innerHTML = `
      <div class="shell">
        <div class="topbar">
          <div class="brand">
            ${logo ? `<img src="${escapeHtml(logo)}" alt="Logo">` : `<div style="width:52px;height:52px;border-radius:14px;background:#fff;display:grid;place-items:center;color:var(--red);font-weight:900">T</div>`}
            <div class="title">
              <h1>${escapeHtml(data.eventName || DEFAULTS.data.eventName)}</h1>
              <div class="sub">Tunierclient</div>
            </div>
          </div>
          <div class="badge">Uhrzeit: <span class="js-clock"></span></div>
        </div>

        <div class="grid client">
          <div class="hero">
            <section class="card">
              <div class="spread">
                <h3>Nächste Gruppe</h3>
                <div class="pill">${escapeHtml(data.nextGroup || "—")}</div>
              </div>
              <div style="margin-top:18px" class="big-value">${escapeHtml(data.nextGroup || "Noch keine Gruppe gesetzt")}</div>
              <div class="muted" style="margin-top:10px">Letzte Aktualisierung: <span class="js-now"></span></div>
            </section>

            <section class="card">
              <h3>Hinweis</h3>
              <div class="muted" style="font-size:1rem;line-height:1.6">${escapeHtml(data.note || "Keine Hinweise hinterlegt.")}</div>
            </section>
          </div>

          <section class="card">
            <div class="spread">
              <h3>Zeiten aller Gruppen</h3>
              <div class="tag">${data.groups.length} Gruppen</div>
            </div>
            <div class="list" style="margin-top:12px">
              ${groupsHtml || `<div class="muted">Noch keine Gruppen angelegt.</div>`}
            </div>
          </section>
        </div>

        <div class="footer">
          <div class="row" style="justify-content:space-between">
            <span>Mobile optimiert · Logo über URL · GitHub Pages</span>
            <span class="muted">Stand: <span class="js-now"></span></span>
          </div>
        </div>
      </div>
    `;
  }

  function renderLive() {
    const root = $("#live-root");
    if (!root || !state.data) return;

    const data = state.data;
    const logo = data.logoUrl || CONFIG.logoUrl || "";

    const placements = data.groups
      .slice()
      .sort((a, b) => {
        const pa = Number.isFinite(Number(a.placement)) ? Number(a.placement) : 9999;
        const pb = Number.isFinite(Number(b.placement)) ? Number(b.placement) : 9999;
        return pa - pb || String(a.name).localeCompare(String(b.name), "de");
      })
      .filter((g) => g.name);

    const repeated = placements.concat(placements);

    const placementRows = repeated
      .map(
        (g) => `
          <div class="place-row">
            <div class="rank">${escapeHtml(g.placement || "—")}</div>
            <div class="group">${escapeHtml(g.name)}</div>
            <div class="score">${escapeHtml(g.final || g.thirdPlace || g.semifinal || g.heats?.[2]?.time || "—")}</div>
          </div>
        `
      )
      .join("");

    root.innerHTML = `
      <div class="shell">
        <div class="topbar">
          <div class="brand">
            ${logo ? `<img src="${escapeHtml(logo)}" alt="Logo">` : `<div style="width:52px;height:52px;border-radius:14px;background:#fff;display:grid;place-items:center;color:var(--red);font-weight:900">L</div>`}
            <div class="title">
              <h2>${escapeHtml(data.eventName || DEFAULTS.data.eventName)} · Live</h2>
              <div class="sub">Horizontale Anzeige</div>
            </div>
          </div>
          <div class="badge">Uhrzeit: <span class="js-clock"></span></div>
        </div>

        <div class="grid live">
          <section class="card">
            <div class="spread">
              <div>
                <h3>Letzte Gruppe</h3>
                <div class="big-value">${escapeHtml(data.lastGroup || "—")}</div>
              </div>
              <div class="pill">Nächste Gruppe: ${escapeHtml(data.nextGroup || "—")}</div>
            </div>
            <hr class="sep">
            <div class="row" style="justify-content:space-between">
              <div>
                <div class="muted small">Aktuelle Uhrzeit</div>
                <div class="clock js-clock">${clockString()}</div>
              </div>
              <div>
                <div class="muted small">Datenstand</div>
                <div class="big-value" style="font-size:1.2rem">${escapeHtml(data.updatedAt ? new Intl.DateTimeFormat("de-DE", { dateStyle: "short", timeStyle: "medium" }).format(new Date(data.updatedAt)) : "—")}</div>
              </div>
            </div>
          </section>

          <section class="card">
            <h3>Platzierung im Scrollmodus</h3>
            <div class="scroll-box" aria-label="Scrollende Platzierungsliste">
              <div class="scroll-track">
                ${placementRows || `<div class="muted">Keine Platzierungen hinterlegt.</div>`}
              </div>
            </div>
          </section>
        </div>
      </div>
    `;
  }

  function updateLoginState() {
    const loginInput = $("#token");
    if (loginInput) loginInput.value = state.token || "";
  }

  async function loginWithToken(token) {
    setStatus("Token wird geprüft …");
    setLoginMessage("Token wird geprüft …");

    const url = `${getApiBase()}/user`;
    const res = await fetch(url, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`
      }
    });

    if (!res.ok) {
      throw new Error("Token ungültig oder ohne Berechtigung.");
    }

    const user = await res.json();
    sessionStorage.setItem("tournament_token", token);
    state.token = token;

    clearLoginMessage();
    setStatus(`Angemeldet als ${user.login}.`);
    await loadData();
    renderAll();
  }

  async function saveCurrentState() {
    try {
      if (!state.token) {
        throw new Error("Kein Token gespeichert.");
      }

      state.data.updatedAt = new Date().toISOString();
      await saveDataPrivate(state.token, state.data);

      setStatus("Gespeichert.");
      await loadData();
      renderAll();
    } catch (err) {
      console.error(err);
      setStatus(err.message || "Speichern fehlgeschlagen", "error");
      alert(err.message || "Speichern fehlgeschlagen");
    }
  }

  async function loadData() {
    try {
      if (state.token && state.token.trim()) {
        try {
          state.data = await readDataPrivate(state.token);
        } catch (privateErr) {
          console.warn("Private load failed, falling back to public:", privateErr);
          state.data = await readDataPublic();
        }
      } else {
        state.data = await readDataPublic();
      }
      state.ready = true;
    } catch (err) {
      console.error(err);
      state.data = normalizeData(DEFAULTS.data);
      setStatus(`Ladefehler: ${err.message}`, "error");
      state.ready = true;
    }
  }

  function renderAll() {
    renderClock();

    const page = document.body.dataset.page;

    if (page === "admin") renderAdmin();
    if (page === "client") renderClient();
    if (page === "live") renderLive();
  }

  function bindGlobal() {
    document.addEventListener("click", async (e) => {
      const target = e.target.closest?.("[data-action]");
      if (!target) return;

      const action = target.dataset.action;

      if (action === "login") {
        try {
          const token = $("#token")?.value.trim();
          if (!token) return alert("Bitte GitHub Token eingeben.");
          await loginWithToken(token);
        } catch (err) {
          console.error(err);
          alert(err.message || "Login fehlgeschlagen");
          setStatus(err.message || "Login fehlgeschlagen", "error");
          setLoginMessage(err.message || "Login fehlgeschlagen", "error");
        }
      }

      if (action === "refresh") {
        await loadData();
        renderAll();
      }
    });

    const loginForm = $("#login-form");
    if (loginForm) {
      loginForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        try {
          const token = $("#token")?.value.trim();
          if (!token) return alert("Bitte GitHub Token eingeben.");
          await loginWithToken(token);
        } catch (err) {
          console.error(err);
          alert(err.message || "Login fehlgeschlagen");
          setStatus(err.message || "Login fehlgeschlagen", "error");
          setLoginMessage(err.message || "Login fehlgeschlagen", "error");
        }
      });
    }
  }

  async function init() {
    bindGlobal();
    renderClock();
    state.clockTimer = setInterval(renderClock, 1000);

    updateLoginState();

    await loadData();
    renderAll();

    if (["client", "live"].includes(document.body.dataset.page)) {
      state.refreshTimer = setInterval(async () => {
        await loadData();
        renderAll();
      }, 8000);
    }
  }

  document.addEventListener("DOMContentLoaded", init);
})();
