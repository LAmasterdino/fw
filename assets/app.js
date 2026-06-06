(function () {
  const CONFIG = window.TOURNAMENT_CONFIG || {};

  const DEFAULTS = {
    eventName: "Turnier",
    logoUrl: "",
    data: {
      version: 1,
      updatedAt: null,
      eventName: "Turnier",
      logoUrl: "",
      nextGroup: "",
      lastGroup: "",
      note: "",
      groups: []
    }
  };

  const state = {
    token: sessionStorage.getItem("tournament_token") || "",
    sha: null,
    data: null,
    ready: false,
    clockTimer: null,
    refreshTimer: null,
    bound: false
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

  function normalizeData(data) {
    const src = data && typeof data === "object" ? data : {};

    return {
      version: src.version || 1,
      updatedAt: src.updatedAt || null,
      eventName: src.eventName || DEFAULTS.data.eventName,
      logoUrl: src.logoUrl || "",
      nextGroup: src.nextGroup || "",
      lastGroup: src.lastGroup || "",
      note: src.note || "",
      groups: Array.isArray(src.groups)
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
        : []
    };
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

  async function apiFetchJson(url, options = {}) {
    const headers = Object.assign(
      { Accept: "application/vnd.github+json" },
      options.headers || {}
    );

    const res = await fetch(url, { ...options, headers });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status} ${res.statusText}${text ? ` — ${text}` : ""}`);
    }
    return res.json();
  }

  async function readDataPublic() {
    const url = rawDataUrl();
    if (!url) return normalizeData(DEFAULTS.data);

    const bust = url.includes("?") ? "&" : "?";
    const res = await fetch(`${url}${bust}v=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`Konnte Daten nicht laden (${res.status})`);
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
    state.sha = json.sha;
    return normalizeData(JSON.parse(content));
  }

  async function saveDataPrivate(token, data) {
    const rp = getRepoPath();
    if (!rp) throw new Error("Repo-Konfiguration fehlt");

    const readUrl = `${getApiBase()}/repos/${encodeURIComponent(rp.owner)}/${encodeURIComponent(rp.repo)}/contents/${rp.path}?ref=${encodeURIComponent(rp.branch)}`;
    const putUrl = `${getApiBase()}/repos/${encodeURIComponent(rp.owner)}/${encodeURIComponent(rp.repo)}/contents/${rp.path}`;

    for (let attempt = 1; attempt <= 2; attempt++) {
      const currentRes = await fetch(readUrl, {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`
        }
      });

      if (!currentRes.ok) {
        const text = await currentRes.text().catch(() => "");
        throw new Error(`Datei konnte nicht gelesen werden (${currentRes.status})${text ? ` — ${text}` : ""}`);
      }

      const current = await currentRes.json();

      const body = {
        message: `Update tournament data ${new Date().toISOString()}`,
        content: toBase64Utf8(JSON.stringify(data, null, 2)),
        sha: current.sha,
        branch: rp.branch
      };

      const saveRes = await fetch(putUrl, {
        method: "PUT",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(body)
      });

      if (saveRes.ok) {
        const json = await saveRes.json();
        state.sha = json.content?.sha || current.sha || state.sha;
        return json;
      }

      const text = await saveRes.text().catch(() => "");
      if (saveRes.status === 409 && attempt === 1) {
        continue;
      }
      throw new Error(`Speichern fehlgeschlagen (${saveRes.status}) ${text}`);
    }

    throw new Error("Speichern fehlgeschlagen (409)");
  }

  function setStatus(msg, error = false) {
    const el = $("#status");
    if (!el) return;
    el.textContent = msg;
    el.classList.toggle("error", !!error);
  }

  function setLoginStatus(msg, error = false) {
    const el = $("#authState");
    if (!el) return;
    el.textContent = msg;
    el.style.background = error ? "rgba(221,13,27,.10)" : "rgba(34,197,94,.12)";
    el.style.color = error ? "var(--red-dark)" : "#15803d";
  }

  function renderClock() {
    $$(".js-clock").forEach((el) => {
      el.textContent = clockString();
    });
    const clock = $("#clock");
    if (clock) clock.textContent = clockString();
    $$(".js-now").forEach((el) => {
      el.textContent = nowString();
    });
  }

  function updateLoginInputs() {
    const tokenInput = $("#token");
    if (tokenInput) tokenInput.value = state.token || "";
  }

  function syncStaticFormFromData() {
    if (!state.data) return;

    const ids = ["eventName", "logoUrl", "nextGroup", "lastGroup", "note"];
    const values = {
      eventName: state.data.eventName || "",
      logoUrl: state.data.logoUrl || "",
      nextGroup: state.data.nextGroup || "",
      lastGroup: state.data.lastGroup || "",
      note: state.data.note || ""
    };

    ids.forEach((id) => {
      const el = document.getElementById(id);
      if (el && el.value !== values[id]) {
        el.value = values[id];
      }
    });
  }

  function syncStaticFormToData() {
    if (!state.data) return;

    const eventName = $("#eventName");
    const logoUrl = $("#logoUrl");
    const nextGroup = $("#nextGroup");
    const lastGroup = $("#lastGroup");
    const note = $("#note");

    if (eventName) state.data.eventName = eventName.value.trim();
    if (logoUrl) state.data.logoUrl = logoUrl.value.trim();
    if (nextGroup) state.data.nextGroup = nextGroup.value.trim();
    if (lastGroup) state.data.lastGroup = lastGroup.value.trim();
    if (note) state.data.note = note.value.trim();
  }

  function renderAdminStaticTable() {
    const body = $("#groupsBody");
    if (!body || !state.data) return;

    body.innerHTML = state.data.groups.map((group) => `
      <tr data-id="${group.id}">
        <td><input class="mini js-field" data-field="name" value="${escapeHtml(group.name)}" placeholder="Gruppenname"></td>
        <td><input class="mini js-field" data-field="heats.0.time" value="${escapeHtml(group.heats?.[0]?.time || "")}" placeholder="Zeit"></td>
        <td><input class="mini js-field" data-field="heats.1.time" value="${escapeHtml(group.heats?.[1]?.time || "")}" placeholder="Zeit"></td>
        <td><input class="mini js-field" data-field="heats.2.time" value="${escapeHtml(group.heats?.[2]?.time || "")}" placeholder="Zeit"></td>
        <td><input class="mini js-field" data-field="semifinal" value="${escapeHtml(group.semifinal || "")}" placeholder="Halbfinale"></td>
        <td><input class="mini js-field" data-field="thirdPlace" value="${escapeHtml(group.thirdPlace || "")}" placeholder="Platz 3"></td>
        <td><input class="mini js-field" data-field="final" value="${escapeHtml(group.final || "")}" placeholder="Finale"></td>
        <td><input class="mini js-field" data-field="placement" value="${escapeHtml(group.placement || "")}" placeholder="Platzierung"></td>
        <td style="text-align:center">
          <input type="checkbox" class="js-field" data-field="qualified" ${group.qualified ? "checked" : ""}>
        </td>
        <td><button class="btn btn-danger js-remove" type="button">-</button></td>
      </tr>
    `).join("");

    $$(".js-field", body).forEach((el) => {
      if (el.type === "checkbox") {
        el.addEventListener("change", onAdminFieldChange);
      } else {
        el.addEventListener("input", onAdminFieldChange);
      }
    });

    $$(".js-remove", body).forEach((btn) => {
      btn.addEventListener("click", () => {
        const tr = btn.closest("tr");
        const id = tr?.dataset?.id;
        if (!id) return;
        state.data.groups = state.data.groups.filter((g) => g.id !== id);
        renderAdminStaticTable();
        setStatus("Gruppe entfernt. Bitte speichern.");
      });
    });
  }

  function onAdminFieldChange(e) {
    const el = e.currentTarget;
    const tr = el.closest("tr");
    const id = tr?.dataset?.id;
    if (!id || !state.data) return;

    const group = state.data.groups.find((g) => g.id === id);
    if (!group) return;

    const field = el.dataset.field;

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

  function renderAdminDynamic() {
    const root = $("#admin-root");
    if (!root || !state.data) return;

    const data = state.data;

    root.innerHTML = `
      <div class="grid admin">
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
            <textarea id="note" placeholder="Hinweis für Live/Client">${escapeHtml(data.note || "")}</textarea>
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
              <tbody id="groupsBody"></tbody>
            </table>
          </div>
        </section>
      </div>
    `;

    syncStaticFormFromData();
    renderAdminStaticTable();
    bindDynamicAdminButtons();
  }

  function renderClient() {
    const root = $("#client-root");
    if (!root || !state.data) return;

    const data = state.data;
    const logo = data.logoUrl || CONFIG.logoUrl || "";

    const groupsHtml = data.groups.map((g) => `
      <div class="list-item">
        <div class="name">${escapeHtml(g.name)}</div>
        <div class="value">${escapeHtml([g.heats?.[0]?.time, g.heats?.[1]?.time, g.heats?.[2]?.time].filter(Boolean).join(" | ") || "—")}</div>
      </div>
    `).join("");

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

    const placementRows = repeated.map((g) => `
      <div class="place-row">
        <div class="rank">${escapeHtml(g.placement || "—")}</div>
        <div class="group">${escapeHtml(g.name)}</div>
        <div class="score">${escapeHtml(g.final || g.thirdPlace || g.semifinal || g.heats?.[2]?.time || "—")}</div>
      </div>
    `).join("");

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

  function setLoginTokenState() {
    const tokenInput = $("#token");
    if (tokenInput) tokenInput.value = state.token || "";
    if (state.token) {
      setLoginStatus("angemeldet");
    } else {
      setLoginStatus("nicht angemeldet");
    }
  }

  async function loginWithToken(token) {
    setStatus("Token wird geprüft …");
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

    setLoginTokenState();
    setStatus(`Angemeldet als ${user.login}.`);
    await loadData();
    renderAll();
  }

  async function saveCurrentState() {
    try {
      if (!state.token) {
        throw new Error("Bitte erst anmelden.");
      }

      syncStaticFormToData();
      state.data.updatedAt = new Date().toISOString();

      await saveDataPrivate(state.token, state.data);

      setStatus("Gespeichert.");
      await loadData();
      renderAll();
    } catch (err) {
      console.error(err);
      setStatus(err.message || "Speichern fehlgeschlagen", true);
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
      syncStaticFormFromData();
      setStatus(`Daten geladen · ${state.data.groups.length} Gruppen`);
    } catch (err) {
      console.error(err);
      state.data = normalizeData(DEFAULTS.data);
      state.ready = true;
      syncStaticFormFromData();
      setStatus(`Ladefehler: ${err.message}`, true);
    }
  }

  function addGroup() {
    if (!state.data) return;
    state.data.groups.push(emptyGroup(`Gruppe ${state.data.groups.length + 1}`));
    renderAdmin();
    setStatus("Neue Gruppe hinzugefügt. Bitte speichern.");
  }

  function bindStaticAdminButtons() {
    const loginBtn = $("#loginBtn");
    const saveBtn = $("#saveBtn");
    const reloadBtn = $("#reloadBtn");
    const addGroupBtn = $("#addGroupBtn");
    const logoutBtn = $("#logoutBtn");
    const tokenInput = $("#token");

    if (loginBtn) {
      loginBtn.addEventListener("click", async () => {
        try {
          const token = tokenInput?.value.trim();
          if (!token) return setStatus("Bitte GitHub Token eingeben.", true);
          await loginWithToken(token);
        } catch (err) {
          console.error(err);
          setStatus(err.message || "Login fehlgeschlagen", true);
          alert(err.message || "Login fehlgeschlagen");
        }
      });
    }

    if (saveBtn) {
      saveBtn.addEventListener("click", saveCurrentState);
    }

    if (reloadBtn) {
      reloadBtn.addEventListener("click", loadData);
    }

    if (addGroupBtn) {
      addGroupBtn.addEventListener("click", addGroup);
    }

    if (logoutBtn) {
      logoutBtn.addEventListener("click", () => {
        state.token = "";
        state.sha = null;
        sessionStorage.removeItem("tournament_token");
        setLoginTokenState();
        updateLoginInputs();
        setStatus("Token gelöscht.");
      });
    }

    if (tokenInput) {
      tokenInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          loginBtn?.click();
        }
      });
    }

    const ids = ["eventName", "logoUrl", "nextGroup", "lastGroup", "note"];
    ids.forEach((id) => {
      const el = document.getElementById(id);
      if (!el) return;
      const evt = el.tagName === "TEXTAREA" ? "input" : "input";
      el.addEventListener(evt, () => {
        if (!state.data) return;
        syncStaticFormToData();
      });
    });
  }

  function bindDynamicAdminButtons() {
    $$(".js-add-group").forEach((btn) => btn.addEventListener("click", addGroup));
    $$(".js-save").forEach((btn) => btn.addEventListener("click", saveCurrentState));
    $$(".js-logout").forEach((btn) => btn.addEventListener("click", () => {
      state.token = "";
      state.sha = null;
      sessionStorage.removeItem("tournament_token");
      setLoginTokenState();
      updateLoginInputs();
      setStatus("Token gelöscht.");
    }));

    ["eventName", "logoUrl", "nextGroup", "lastGroup", "note"].forEach((id) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener("input", () => {
        if (!state.data) return;
        syncStaticFormToData();
      });
    });

    const tokenInput = $("#token");
    if (tokenInput) {
      tokenInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          $("#loginBtn")?.click();
        }
      });
    }
  }

  function bindClientLiveRefresh() {
    if (["client", "live"].includes(document.body.dataset.page)) {
      state.refreshTimer = setInterval(async () => {
        await loadData();
        renderAll();
      }, 8000);
    }
  }

  function renderAll() {
    renderClock();

    const page = document.body.dataset.page || "admin";

    if (page === "admin") {
      if ($("#groupsBody")) {
        renderAdminStaticTable();
      } else {
        renderAdminDynamic();
      }
    }

    if (page === "client") renderClient();
    if (page === "live") renderLive();
  }

  function bind() {
    if (state.bound) return;
    state.bound = true;

    bindStaticAdminButtons();

    document.addEventListener("click", async (e) => {
      const btn = e.target.closest?.("[data-action]");
      if (!btn) return;

      const action = btn.dataset.action;

      if (action === "login") {
        try {
          const token = $("#token")?.value.trim();
          if (!token) return setStatus("Bitte GitHub Token eingeben.", true);
          await loginWithToken(token);
        } catch (err) {
          console.error(err);
          setStatus(err.message || "Login fehlgeschlagen", true);
          alert(err.message || "Login fehlgeschlagen");
        }
      }

      if (action === "refresh") {
        await loadData();
        renderAll();
      }
    });

    if (document.body.dataset.page === "admin") {
      const tokenInput = $("#token");
      if (tokenInput) {
        tokenInput.addEventListener("keydown", (e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            loginWithToken(tokenInput.value.trim()).catch((err) => {
              console.error(err);
              setStatus(err.message || "Login fehlgeschlagen", true);
            });
          }
        });
      }
    }
  }

  async function init() {
    bind();

    renderClock();
    state.clockTimer = setInterval(renderClock, 1000);

    updateLoginInputs();
    setLoginTokenState();

    await loadData();
    renderAll();

    bindClientLiveRefresh();
  }

  document.addEventListener("DOMContentLoaded", init);
})();
